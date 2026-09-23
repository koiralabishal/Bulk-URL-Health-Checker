import type { BatchRow, BatchUrlRow } from "@urlchecker/db";
import type { BatchDetail, BatchSummary, UrlCounts, UrlResult } from "@urlchecker/shared";
import { BATCH_STATUSES, URL_STATUSES } from "@urlchecker/shared";

export function toUrlResult(row: BatchUrlRow): UrlResult {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    httpStatus: row.httpStatus ?? undefined,
    responseMs: row.responseMs ?? undefined,
    pageTitle: row.pageTitle ?? undefined,
    attempts: row.attempts,
    error: row.error ?? undefined,
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export function countUrls(urls: BatchUrlRow[]): UrlCounts {
  const counts: UrlCounts = { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of urls) counts[row.status] += 1;
  return counts;
}

export function toBatchSummary(batch: BatchRow, urls: BatchUrlRow[]): BatchSummary {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    totalCount: batch.totalCount,
    counts: countUrls(urls),
  };
}

export function toBatchDetail(batch: BatchRow, urls: BatchUrlRow[]): BatchDetail {
  return {
    ...toBatchSummary(batch, urls),
    urls: urls.map(toUrlResult),
  };
}

export const ALL_BATCH_STATUSES = BATCH_STATUSES;
export const ALL_URL_STATUSES = URL_STATUSES;