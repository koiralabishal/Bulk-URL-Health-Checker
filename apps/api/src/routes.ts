import { and, count, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { batches, batchUrls } from "@urlchecker/db";
import type {
  BatchDetail,
  BatchList,
  BatchStatus,
  BatchSummary,
  CreateBatchResponse,
  DeleteBatchResponse,
  DeleteUrlsResponse,
  UrlCounts,
} from "@urlchecker/shared";
import {
  BatchesPageSchema,
  BulkDeleteBatchesSchema,
  BulkDeleteUrlsSchema,
  CreateBatchResponseSchema,
  CreateBatchSchema,
  DEFAULT_PAGE_SIZE,
  MAX_BATCH_SIZE,
  MAX_PAGE_SIZE,
} from "@urlchecker/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "./db";
import { findBatchById, findUrlsByBatchId } from "./queries";
import { toBatchDetail, toBatchSummary } from "./dto";
import { getBatchesPage, invalidateBatchesList, setBatchesPage } from "./cache";
import { publish } from "./events";
import { jobIdFor, urlQueue, type UrlCheckJobData } from "./queue";

const TERMINAL: BatchStatus[] = ["completed", "cancelled"];
const TERMINAL_URL_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export async function getBatchDetail(batchId: string): Promise<BatchDetail | null> {
  const [batch, urls] = await Promise.all([findBatchById(batchId), findUrlsByBatchId(batchId)]);
  if (!batch) return null;

  // Self-heal: a Redis blip during finalize can leave every row terminal while the
  // batch header is still pending/running (completion notification never landed).
  // Repair on read so the UI never sticks on a finished batch.
  let healed = batch;
  if (
    (batch.status === "running" || batch.status === "pending") &&
    urls.length > 0 &&
    urls.every((u) => TERMINAL_URL_STATUSES.includes(u.status as never))
  ) {
    const [updated] = await db
      .update(batches)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(batches.id, batchId), inArray(batches.status, ["running", "pending"])))
      .returning();
    if (updated) {
      healed = updated;
      invalidateBatchesList().catch(() => {});
      const summary = await getBatchSummary(batchId).catch(() => null);
      if (summary) publish(batchId, { type: "batch_updated", batchId, batch: summary }).catch(() => {});
    }
  }

  return toBatchDetail(healed, urls);
}

export async function getBatchSummary(batchId: string): Promise<BatchSummary | null> {
  const [batch, urls] = await Promise.all([findBatchById(batchId), findUrlsByBatchId(batchId)]);
  if (!batch) return null;
  return toBatchSummary(batch, urls);
}

function parseUrlList(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const url = entry.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, MAX_BATCH_SIZE);
}

async function readCsvUrls(req: FastifyRequest): Promise<string[]> {
  const file = await req.file();
  if (!file) throw new Error("Expected a CSV file upload");
  const buffer = await file.toBuffer();
  const text = buffer.toString("utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((url) => url && url.toLowerCase() !== "url");
}

async function removeWaitingJobs(filter: (job: { data: UrlCheckJobData }) => boolean): Promise<void> {
  const jobs = await urlQueue.getJobs(["waiting", "delayed", "prioritized"]);
  await Promise.all(jobs.filter(filter).map((job) => job.remove()));
}

/** Keep header in sync after URL deletes; remove the batch if it became empty. */
async function syncBatchAfterUrlDeletes(batchId: string): Promise<{ batchDeleted: boolean; totalCount: number }> {
  const remaining = await db
    .select({ id: batchUrls.id })
    .from(batchUrls)
    .where(eq(batchUrls.batchId, batchId));

  if (remaining.length === 0) {
    await removeWaitingJobs((job) => job.data.batchId === batchId);
    await db.delete(batches).where(eq(batches.id, batchId));
    return { batchDeleted: true, totalCount: 0 };
  }

  await db
    .update(batches)
    .set({ totalCount: remaining.length, updatedAt: new Date() })
    .where(eq(batches.id, batchId));
  return { batchDeleted: false, totalCount: remaining.length };
}

export async function registerBatchesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: unknown; Reply: CreateBatchResponse }>(
    "/api/batches",
    async (req, reply) => {
      let urls: string[];
      if (req.isMultipart()) {
        urls = parseUrlList(await readCsvUrls(req).catch(() => []));
      } else {
        const parsed = CreateBatchSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" } as never);
        }
        urls = parseUrlList(parsed.data.urls);
      }

      if (urls.length === 0) {
        return reply.code(400).send({ error: "No valid URLs provided" } as never);
      }

      const batch = await db.transaction(async (tx) => {
    const inserted = await tx.insert(batches).values({ totalCount: urls.length }).returning();
    const created = inserted[0];
    if (!created) throw new Error("failed to create batch");
    await tx.insert(batchUrls).values(urls.map((url) => ({ batchId: created.id, url })));
    return created;
  });

      const rows = await findUrlsByBatchId(batch.id);
      await urlQueue.addBulk(
        rows.map((row) => {
          const data: UrlCheckJobData = { batchId: batch.id, urlId: row.id, runSeq: 0 };
          return { name: "check", data, opts: { jobId: jobIdFor(data) } };
        }),
      );

      await db
        .update(batches)
        .set({ status: "running", updatedAt: new Date() })
        .where(and(eq(batches.id, batch.id), eq(batches.status, "pending")));

      await invalidateBatchesList();
      const summary = await getBatchSummary(batch.id);
      if (summary) await publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary });

      return CreateBatchResponseSchema.parse({ batchId: batch.id });
    },
  );

  fastify.get<{ Querystring: { page?: string; pageSize?: string } }>(
    "/api/batches",
    async (req, reply) => {
      const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Number.parseInt(req.query.pageSize ?? `${DEFAULT_PAGE_SIZE}`, 10) || DEFAULT_PAGE_SIZE),
      );

      const { data: cached, version } = await getBatchesPage(page, pageSize);
      if (cached) return cached;

      const [totalRow] = await db.select({ value: count() }).from(batches);
      const total = totalRow?.value ?? 0;

      const recent = await db
        .select()
        .from(batches)
        .orderBy(desc(batches.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const countRows = recent.length
        ? await db
            .select({ batchId: batchUrls.batchId, status: batchUrls.status, count: count() })
            .from(batchUrls)
            .where(inArray(batchUrls.batchId, recent.map((b) => b.id)))
            .groupBy(batchUrls.batchId, batchUrls.status)
        : [];

      const countsByBatch = new Map<string, UrlCounts>();
      for (const row of countRows) {
        const entry = countsByBatch.get(row.batchId) ?? { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 };
        entry[row.status] = row.count;
        countsByBatch.set(row.batchId, entry);
      }

      const items = recent.map((batch) => ({
        id: batch.id,
        status: batch.status,
        createdAt: batch.createdAt.toISOString(),
        updatedAt: batch.updatedAt.toISOString(),
        totalCount: batch.totalCount,
        counts: countsByBatch.get(batch.id) ?? { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }));

      const data = BatchesPageSchema.parse({ items, total, page, pageSize });
      await setBatchesPage(page, pageSize, data, version);
      return reply.send(data);
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/batches/:id", async (req, reply) => {
    const detail = await getBatchDetail(req.params.id);
    if (!detail) return reply.code(404).send({ error: "Batch not found" } as never);
    return detail;
  });

  fastify.post<{ Params: { id: string } }>("/api/batches/:id/cancel", async (req, reply) => {
    const batch = await findBatchById(req.params.id);
    if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

    if (!TERMINAL.includes(batch.status)) {
      await db
        .update(batches)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(batches.id, batch.id), notInArray(batches.status, TERMINAL)));

      await db
        .update(batchUrls)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(and(eq(batchUrls.batchId, batch.id), inArray(batchUrls.status, ["queued", "checking"])));
    }

    // Remove queued/delayed jobs for this batch; active jobs self-cancel via the DB guard.
    const jobs = await urlQueue.getJobs(["waiting", "delayed", "prioritized"]);
    await Promise.all(jobs.filter((job) => job.data.batchId === batch.id).map((job) => job.remove()));

    await invalidateBatchesList();
    const summary = await getBatchSummary(batch.id);
    if (summary) await publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary });

    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>("/api/batches/:id/retry-failed", async (req, reply) => {
    const batch = await findBatchById(req.params.id);
    if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

    const failed = await db
      .select({ id: batchUrls.id })
      .from(batchUrls)
      .where(and(eq(batchUrls.batchId, batch.id), eq(batchUrls.status, "failed")));

    if (failed.length === 0) {
      return { retried: 0 };
    }

    const runSeq = batch.runSeq + 1;

    await db
      .update(batchUrls)
      .set({ status: "queued", error: null })
      .where(and(eq(batchUrls.batchId, batch.id), eq(batchUrls.status, "failed")));

    await db
      .update(batches)
      .set({
        status: "running",
        runSeq,
        updatedAt: new Date(),
      })
      .where(and(eq(batches.id, batch.id), ne(batches.status, "cancelled")));

    await urlQueue.addBulk(
      failed.map((row) => {
        const data: UrlCheckJobData = { batchId: batch.id, urlId: row.id, runSeq };
        return { name: "check", data, opts: { jobId: jobIdFor(data) } };
      }),
    );

    await invalidateBatchesList();
    const summary = await getBatchSummary(batch.id);
    if (summary) await publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary });

    return { retried: failed.length, runSeq };
  });

  // Re-analyze every URL in a batch from scratch (fresh results, new run).
  fastify.post<{ Params: { id: string } }>("/api/batches/:id/re-analyze", async (req, reply) => {
    const batch = await findBatchById(req.params.id);
    if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

    const rows = await db.select({ id: batchUrls.id }).from(batchUrls).where(eq(batchUrls.batchId, batch.id));
    if (rows.length === 0) return reply.code(400).send({ error: "Batch has no URLs" } as never);

    // Drop any jobs still waiting from the previous run before re-enqueueing.
    const jobs = await urlQueue.getJobs(["waiting", "delayed", "prioritized"]);
    await Promise.all(jobs.filter((job) => job.data.batchId === batch.id).map((job) => job.remove()));

    const runSeq = batch.runSeq + 1;

    await db
      .update(batchUrls)
      .set({
        status: "queued",
        httpStatus: null,
        responseMs: null,
        pageTitle: null,
        attempts: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
      })
      .where(eq(batchUrls.batchId, batch.id));

    await db
      .update(batches)
      .set({ status: "running", runSeq, updatedAt: new Date() })
      .where(eq(batches.id, batch.id));

    await urlQueue.addBulk(
      rows.map((row) => {
        const data: UrlCheckJobData = { batchId: batch.id, urlId: row.id, runSeq };
        return { name: "check", data, opts: { jobId: jobIdFor(data) } };
      }),
    );

    await invalidateBatchesList();
    const summary = await getBatchSummary(batch.id);
    if (summary) await publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary });

    return { ok: true, reanalyzed: rows.length, runSeq };
  });

  // Re-analyze a single URL inside a batch.
  fastify.post<{ Params: { id: string; urlId: string } }>(
    "/api/batches/:id/urls/:urlId/re-analyze",
    async (req, reply) => {
      const batch = await findBatchById(req.params.id);
      if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

      const [row] = await db
        .select({ id: batchUrls.id })
        .from(batchUrls)
        .where(and(eq(batchUrls.id, req.params.urlId), eq(batchUrls.batchId, batch.id)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "URL not found in this batch" } as never);

      // Drop this URL's jobs still waiting from the previous run.
      const jobs = await urlQueue.getJobs(["waiting", "delayed", "prioritized"]);
      await Promise.all(
        jobs
          .filter((job) => job.data.batchId === batch.id && job.data.urlId === row.id)
          .map((job) => job.remove()),
      );

      const runSeq = batch.runSeq + 1;

      await db
        .update(batchUrls)
        .set({
          status: "queued",
          httpStatus: null,
          responseMs: null,
          pageTitle: null,
          attempts: 0,
          error: null,
          startedAt: null,
          finishedAt: null,
        })
        .where(eq(batchUrls.id, row.id));

      await db
        .update(batches)
        .set({ status: "running", runSeq, updatedAt: new Date() })
        .where(eq(batches.id, batch.id));

      const data: UrlCheckJobData = { batchId: batch.id, urlId: row.id, runSeq };
      await urlQueue.add("check", data, { jobId: jobIdFor(data) });

      await invalidateBatchesList();
      const summary = await getBatchSummary(batch.id);
      if (summary) await publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary });

      return { ok: true, runSeq };
    },
  );

  // ---- Delete ----------------------------------------------------------

  // Delete one batch (FK cascade removes its URL rows).
  fastify.delete<{ Params: { id: string }; Reply: DeleteBatchResponse }>(
    "/api/batches/:id",
    async (req, reply) => {
      const batch = await findBatchById(req.params.id);
      if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

      await removeWaitingJobs((job) => job.data.batchId === batch.id);
      await db.delete(batches).where(eq(batches.id, batch.id));

      await invalidateBatchesList();
      return { ok: true, deleted: 1 };
    },
  );

  // Bulk delete batches by id.
  fastify.delete<{ Body: unknown }>("/api/batches", async (req, reply) => {
    const parsed = BulkDeleteBatchesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" } as never);
    }
    const ids = [...new Set(parsed.data.ids)];

    await removeWaitingJobs((job) => ids.includes(job.data.batchId));
    await db.delete(batches).where(inArray(batches.id, ids));

    await invalidateBatchesList();
    return { ok: true as const, deleted: ids.length };
  });

  // Delete one URL row from a batch.
  fastify.delete<{ Params: { id: string; urlId: string } }>(
    "/api/batches/:id/urls/:urlId",
    async (req, reply) => {
      const batch = await findBatchById(req.params.id);
      if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

      const [row] = await db
        .select({ id: batchUrls.id })
        .from(batchUrls)
        .where(and(eq(batchUrls.id, req.params.urlId), eq(batchUrls.batchId, batch.id)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "URL not found in this batch" } as never);

      await removeWaitingJobs((job) => job.data.batchId === batch.id && job.data.urlId === row.id);
      await db.delete(batchUrls).where(eq(batchUrls.id, row.id));

      const { batchDeleted, totalCount } = await syncBatchAfterUrlDeletes(batch.id);
      await invalidateBatchesList();
      if (!batchDeleted) {
        const summary = await getBatchSummary(batch.id).catch(() => null);
        if (summary) publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary }).catch(() => {});
      }

      return { ok: true as const, deleted: 1, batchDeleted, totalCount };
    },
  );

  // Bulk delete URL rows from one batch.
  fastify.delete<{ Params: { id: string }; Body: unknown }>(
    "/api/batches/:id/urls",
    async (req, reply) => {
      const batch = await findBatchById(req.params.id);
      if (!batch) return reply.code(404).send({ error: "Batch not found" } as never);

      const parsed = BulkDeleteUrlsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" } as never);
      }
      const urlIds = [...new Set(parsed.data.urlIds)];

      const owned = await db
        .select({ id: batchUrls.id })
        .from(batchUrls)
        .where(and(eq(batchUrls.batchId, batch.id), inArray(batchUrls.id, urlIds)));
      const ownedIds = owned.map((r) => r.id);
      if (ownedIds.length === 0) {
        return reply.code(404).send({ error: "No matching URLs in this batch" } as never);
      }

      const ownedSet = new Set(ownedIds);
      await removeWaitingJobs((job) => job.data.batchId === batch.id && ownedSet.has(job.data.urlId));
      await db.delete(batchUrls).where(inArray(batchUrls.id, ownedIds));

      const { batchDeleted, totalCount } = await syncBatchAfterUrlDeletes(batch.id);
      await invalidateBatchesList();
      if (!batchDeleted) {
        const summary = await getBatchSummary(batch.id).catch(() => null);
        if (summary) publish(batch.id, { type: "batch_updated", batchId: batch.id, batch: summary }).catch(() => {});
      }

      return { ok: true as const, deleted: ownedIds.length, batchDeleted, totalCount };
    },
  );
}