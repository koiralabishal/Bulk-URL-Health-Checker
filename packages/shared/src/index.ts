import { z } from "zod";

export const BATCH_STATUSES = ["pending", "running", "completed", "cancelled"] as const;
export const URL_STATUSES = ["queued", "checking", "succeeded", "failed", "cancelled"] as const;

export const BatchStatusSchema = z.enum(BATCH_STATUSES);
export const UrlStatusSchema = z.enum(URL_STATUSES);

export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type UrlStatus = z.infer<typeof UrlStatusSchema>;

export const MAX_BATCH_SIZE = 1000;
export const MAX_TITLE_LENGTH = 500;
export const BATCH_LIST_CACHE_KEY = "cache:batches:list";
export const BATCH_LIST_CACHE_TTL_SECONDS = 30;

export function batchChannel(batchId: string): string {
  return `batch:${batchId}`;
}

/**
 * Pub/sub channel for list-level `batch_updated` events so the history table
 * can stream without one socket per visible batch. Prefixed `batch:` so the
 * existing WS router accepts it; real batch ids are UUIDs and never "list".
 */
export const BATCHES_LIST_CHANNEL = "batch:list";

export const CreateBatchSchema = z.object({
  urls: z
    .array(z.string().trim().url())
    .min(1, "At least one URL is required")
    .max(MAX_BATCH_SIZE, `At most ${MAX_BATCH_SIZE} URLs per batch`),
});

export type CreateBatchInput = z.infer<typeof CreateBatchSchema>;

export const CreateBatchResponseSchema = z.object({
  batchId: z.string().uuid(),
});

export type CreateBatchResponse = z.infer<typeof CreateBatchResponseSchema>;

export const CountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  checking: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

export type UrlCounts = z.infer<typeof CountsSchema>;

export const UrlResultSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  status: UrlStatusSchema,
  httpStatus: z.number().int().nullish(),
  responseMs: z.number().int().nullish(),
  pageTitle: z.string().nullish(),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullish(),
  finishedAt: z.string().nullish(),
});

export type UrlResult = z.infer<typeof UrlResultSchema>;

export const BatchSummarySchema = z.object({
  id: z.string().uuid(),
  status: BatchStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  totalCount: z.number().int().nonnegative(),
  counts: CountsSchema,
});

export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const BatchDetailSchema = BatchSummarySchema.extend({
  urls: z.array(UrlResultSchema),
});

export type BatchDetail = z.infer<typeof BatchDetailSchema>;

export const BatchListSchema = z.array(BatchSummarySchema);
export type BatchList = z.infer<typeof BatchListSchema>;

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

export const BatchesPageSchema = z.object({
  items: z.array(BatchSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
});
export type BatchesPage = z.infer<typeof BatchesPageSchema>;

export const BulkDeleteBatchesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "Select at least one batch").max(100),
});

export const BulkDeleteUrlsSchema = z.object({
  urlIds: z.array(z.string().uuid()).min(1, "Select at least one URL").max(1000),
});

export const DeleteBatchResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.number().int().nonnegative(),
});

export const DeleteUrlsResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.number().int().nonnegative(),
  batchDeleted: z.boolean().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});

export type BulkDeleteBatchesInput = z.infer<typeof BulkDeleteBatchesSchema>;
export type BulkDeleteUrlsInput = z.infer<typeof BulkDeleteUrlsSchema>;
export type DeleteBatchResponse = z.infer<typeof DeleteBatchResponseSchema>;
export type DeleteUrlsResponse = z.infer<typeof DeleteUrlsResponseSchema>;

export const ServerToClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    batchId: z.string().uuid(),
    batch: BatchDetailSchema,
  }),
  z.object({
    type: z.literal("url_updated"),
    batchId: z.string().uuid(),
    url: UrlResultSchema,
  }),
  z.object({
    type: z.literal("batch_updated"),
    batchId: z.string().uuid(),
    batch: BatchSummarySchema,
  }),
  z.object({
    type: z.literal("pong"),
  }),
]);

export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>;

export const ClientToServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;