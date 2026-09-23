import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const batchStatusEnum = pgEnum("batch_status", [
  "pending",
  "running",
  "completed",
  "cancelled",
]);

export const urlStatusEnum = pgEnum("url_status", [
  "queued",
  "checking",
  "succeeded",
  "failed",
  "cancelled",
]);

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: batchStatusEnum("status").default("pending").notNull(),
    totalCount: integer("total_count").notNull(),
    runSeq: integer("run_seq").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("batches_created_at_idx").on(t.createdAt)],
);

export const batchUrls = pgTable(
  "batch_urls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    status: urlStatusEnum("status").default("queued").notNull(),
    httpStatus: integer("http_status"),
    responseMs: integer("response_ms"),
    pageTitle: text("page_title"),
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("batch_urls_batch_id_url_unique").on(t.batchId, t.url),
    index("batch_urls_batch_id_status_idx").on(t.batchId, t.status),
  ],
);

export type BatchRow = typeof batches.$inferSelect;
export type BatchUrlRow = typeof batchUrls.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;
export type NewBatchUrlRow = typeof batchUrls.$inferInsert;