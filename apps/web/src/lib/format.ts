import type { BatchStatus, UrlStatus, UrlCounts, UrlResult } from "@urlchecker/shared";
import { URL_STATUSES } from "@urlchecker/shared";

export function countUrlRows(urls: UrlResult[]): UrlCounts {
  const counts: UrlCounts = { queued: 0, checking: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const url of urls) counts[url.status] += 1;
  return counts;
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

export const STATUS_LABELS: Record<UrlStatus, string> = {
  queued: "Queued",
  checking: "Checking",
  succeeded: "OK",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const STATUS_ORDER: UrlStatus[] = [...URL_STATUSES];

export function progressOf(batch: { status: BatchStatus; totalCount: number; counts: UrlCounts }): number {
  const { totalCount } = batch;
  if (totalCount === 0) return 0;
  const terminal = batch.counts.succeeded + batch.counts.failed + batch.counts.cancelled;
  return Math.round((terminal / totalCount) * 100);
}