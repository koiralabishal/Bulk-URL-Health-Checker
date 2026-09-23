import { eq } from "drizzle-orm";
import { batches, batchUrls, type BatchRow, type BatchUrlRow } from "@urlchecker/db";
import { db } from "./db";

export async function findBatchById(id: string): Promise<BatchRow | undefined> {
  const rows = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  return rows;
}

export async function findUrlsByBatchId(id: string): Promise<BatchUrlRow[]> {
  return db.query.batchUrls.findMany({
    where: eq(batchUrls.batchId, id),
    orderBy: (t) => [t.id],
  });
}