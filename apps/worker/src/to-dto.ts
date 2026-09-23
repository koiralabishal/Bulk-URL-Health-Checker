import type { BatchUrlRow } from "@urlchecker/db";
import type { UrlResult } from "@urlchecker/shared";

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