import { and, count, eq, inArray, sql } from "drizzle-orm";
import { batches, batchUrls, type BatchUrlRow } from "@urlchecker/db";
import {
  batchChannel,
  BATCHES_LIST_CHANNEL,
  BATCH_LIST_CACHE_KEY,
  type ServerToClientMessage,
  type UrlCounts,
} from "@urlchecker/shared";
import { Job, Worker } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";
import { db, pool } from "./db";
import { checkUrl, type CheckOutcome } from "./check";
import { toUrlResult } from "./to-dto";

export const URL_QUEUE_NAME = "url-check";

export type UrlCheckJobData = {
  batchId: string;
  urlId: string;
  runSeq: number;
};

const TERMINAL_URL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const options: RedisOptions = {
  enableReadyCheck: false,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  // A BullMQ Worker requires an unbounded ioredis client: blocking commands (BZPOPMIN)
  // must wait out reconnects instead of erroring after N attempts.
  maxRetriesPerRequest: null,
};

const workerConnection = new Redis(env.REDIS_URL, options);
// Separate client for PUBLISH/DEL so we never run non-blocking commands interleaved
// with the worker's blocking commands on the same connection.
const publishClient = new Redis(env.REDIS_URL, {
  enableReadyCheck: false,
  maxRetriesPerRequest: 1,
});

workerConnection.on("error", (err) => console.error(`[redis:worker] ${err.message}`));
publishClient.on("error", (err) => console.error(`[redis:publish] ${err.message}`));

async function publish(batchId: string, message: ServerToClientMessage): Promise<void> {
  await publishClient.publish(batchChannel(batchId), JSON.stringify(message));
}

// Redis notifications (WS fan-out, list cache) are best-effort: a Redis blip must
// never prevent the DB from reaching a terminal state.
function notifyBatch(batchId: string, message: ServerToClientMessage): void {
  publish(batchId, message).catch(() => {});
  // The history table subscribes to one shared list channel.
  if (message.type === "batch_updated") {
    publishClient.publish(BATCHES_LIST_CHANNEL, JSON.stringify(message)).catch(() => {});
  }
}

// Recompute counts from the DB and stream a fresh summary so live list views
// (history table) tick with every URL outcome, not only at full completion.
async function notifyBatchSummary(batchId: string): Promise<void> {
  try {
    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1);
    if (!batch) return;
    const countRows = await db
      .select({ status: batchUrls.status, n: count() })
      .from(batchUrls)
      .where(eq(batchUrls.batchId, batchId))
      .groupBy(batchUrls.status);
    const counts: UrlCounts = { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of countRows) counts[row.status] = Number(row.n);
    notifyBatch(batchId, {
      type: "batch_updated",
      batchId,
      batch: {
        id: batch.id,
        status: batch.status,
        createdAt: batch.createdAt.toISOString(),
        updatedAt: batch.updatedAt.toISOString(),
        totalCount: batch.totalCount,
        counts,
      },
    });
  } catch {
    /* best-effort */
  }
}

async function invalidateListCache(): Promise<void> {
  // Match the API's versioned list cache: bump the version prefix so every
  // cached page key becomes unreachable at once (plain DEL of the old flat key
  // would delete nothing after the pagination redesign).
  await publishClient.incr(`${BATCH_LIST_CACHE_KEY}:ver`).catch(() => {});
}

async function maybeCompleteBatch(batchId: string): Promise<void> {
  const statuses = await db.select({ status: batchUrls.status }).from(batchUrls).where(eq(batchUrls.batchId, batchId));
  if (statuses.length === 0 || statuses.some((row) => !TERMINAL_URL_STATUSES.has(row.status))) return;

  const [updated] = await db
    .update(batches)
    .set({ status: "completed", updatedAt: new Date() })
    .where(and(eq(batches.id, batchId), eq(batches.status, "running")))
    .returning();

  if (updated) {
    await invalidateListCache();
    const urls = await db.select().from(batchUrls).where(eq(batchUrls.batchId, batchId));
    const counts: UrlCounts = { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of urls) counts[row.status] += 1;
    notifyBatch(batchId, {
      type: "batch_updated",
      batchId,
      batch: {
        id: updated.id,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        totalCount: updated.totalCount,
        counts,
      },
    });
  }
}

async function handleUrlOutcome(
  batchId: string,
  urlId: string,
  outcome: CheckOutcome,
): Promise<void> {
  if (outcome.ok) {
    const [updated] = await db
      .update(batchUrls)
      .set({
        status: "succeeded",
        httpStatus: outcome.httpStatus,
        responseMs: outcome.responseMs,
        pageTitle: outcome.title ?? null,
        error: null,
        finishedAt: new Date(),
      })
      .where(and(eq(batchUrls.id, urlId), eq(batchUrls.status, "checking")))
      .returning();

    if (updated) {
      await invalidateListCache().catch(() => {});
      notifyBatch(batchId, { type: "url_updated", batchId, url: toUrlResult(updated) });
      await maybeCompleteBatch(batchId);
      await notifyBatchSummary(batchId);
    }
    return;
  }

  const [updated] = await db
    .update(batchUrls)
    .set({
      status: "failed",
      httpStatus: outcome.httpStatus,
      error: outcome.error,
      finishedAt: new Date(),
    })
    .where(and(eq(batchUrls.id, urlId), eq(batchUrls.status, "checking")))
    .returning();

  if (updated) {
    await invalidateListCache().catch(() => {});
    notifyBatch(batchId, { type: "url_updated", batchId, url: toUrlResult(updated) });
    await maybeCompleteBatch(batchId);
    await notifyBatchSummary(batchId);
  }
}

async function processCheck(job: Job<UrlCheckJobData>): Promise<void> {
  const { batchId, urlId } = job.data;

  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1);
  if (!batch || batch.status !== "running") return;

  // Idempotent claim: only queued/failed/checking rows are claimable. A redelivered job
  // whose row is already terminal (succeeded/failed/cancelled) no-ops at the DB layer.
  const [claimed] = await db
    .update(batchUrls)
    .set({
      status: "checking",
      startedAt: new Date(),
      attempts: sql`${batchUrls.attempts} + 1`,
    })
    .where(and(eq(batchUrls.id, urlId), inArray(batchUrls.status, ["queued", "failed", "checking"])))
    .returning();
  if (!claimed) return;

  const outcome = await checkUrl(claimed.url);

  if (!outcome.ok && outcome.transient) {
    const attemptsTotal = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= attemptsTotal;
    if (isLastAttempt) {
      await handleUrlOutcome(batchId, urlId, outcome);
    }
    // Otherwise leave the row "checking"; the retried delivery claims it again.
    throw new Error(outcome.error);
  }

  await handleUrlOutcome(batchId, urlId, outcome);
}

export function createWorker(): Worker<UrlCheckJobData> {
  const worker = new Worker<UrlCheckJobData>(URL_QUEUE_NAME, processCheck, {
    connection: workerConnection,
    concurrency: 5,
    limiter: {
      // Global 10 requests/sec enforced by a shared Redis Lua script — this holds across
      // every worker process, because the rate is tracked on the queue, not per process.
      max: 10,
      duration: 1000,
    },
  });

  worker.on("failed", async (job, err) => {
    console.warn(`[worker] job ${job?.id} failed: ${err.message} at=${new Date().toISOString()}`);
    if (!job) return;
    // Fallback: only when a job truly exhausts its attempts without our processor
    // marking the row (e.g. an unexpected error), still reflect failure in the DB.
    // BullMQ emits 'failed' on every failed attempt, not just the final one, and by
    // then attemptsMade is already incremented past the attempt that just failed, so
    // the final attempt is exactly attemptsMade >= opts.attempts.
    if ((job.attemptsMade ?? 0) < (job.opts.attempts ?? 1)) return;
    const [updated] = await db
      .update(batchUrls)
      .set({ status: "failed", error: `max retries exceeded: ${err.message}`, finishedAt: new Date() })
      .where(and(eq(batchUrls.id, job.data.urlId), eq(batchUrls.status, "checking")))
      .returning();
    if (updated) await maybeCompleteBatch(job.data.batchId).catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[worker] error:", err.message);
  });

  return worker;
}

await (async () => {
  const worker = createWorker();
  console.log(`[worker] listening on queue ${URL_QUEUE_NAME} (concurrency 5, 10 req/s global)`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    await worker.close().catch(() => {});
    await workerConnection.quit().catch(() => {});
    await publishClient.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
})();