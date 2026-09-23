"use client";

import Link from "next/link";
import { CancelBatchButton, ReanalyzeBatchButton, ReanalyzeUrlButton, RetryFailedButton } from "@/components/actions";
import { BATCH_STATUS_LABELS, formatDate, formatDuration, progressOf, STATUS_LABELS } from "@/lib/format";
import { useBatchSocket } from "@/lib/use-batch-socket";
import type { BatchDetail } from "@urlchecker/shared";

const BATCH_PILL: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  running: "bg-sky-50 text-sky-700 ring-sky-600/20",
  pending: "bg-stone-100 text-stone-600 ring-stone-500/15",
  cancelled: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

const URL_PILL: Record<string, string> = {
  succeeded: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  checking: "bg-sky-50 text-sky-700 ring-sky-600/20",
  queued: "bg-stone-100 text-stone-600 ring-stone-500/15",
  cancelled: "bg-violet-50 text-violet-700 ring-violet-600/20",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

export default function BatchLive({ batchId, initial }: { batchId: string; initial: BatchDetail }) {
  const { batch, connected } = useBatchSocket(batchId, initial);
  const progress = progressOf(batch);
  const active = batch.status === "running" || batch.status === "pending";

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/batches"
          className="text-sm font-medium text-stone-500 transition hover:text-indigo-600 hover:no-underline"
        >
          ← History
        </Link>
      </div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-2xl font-bold tracking-tight">
              {batch.id.slice(0, 8)}
            </h1>
            <span
              className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${BATCH_PILL[batch.status] ?? BATCH_PILL.pending}`}
            >
              {BATCH_STATUS_LABELS[batch.status]}
            </span>
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? "animate-pulse bg-emerald-500" : "bg-stone-300"
              }`}
              title={connected ? "Live — streaming updates" : "Reconnecting…"}
            />
            {connected && (
              <span className="text-xs font-medium text-stone-400">live</span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-stone-500">
            {batch.totalCount} URLs · started {formatDate(batch.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RetryFailedButton batchId={batchId} failedCount={batch.counts.failed} />
          {active && <CancelBatchButton batchId={batchId} />}
          <ReanalyzeBatchButton batchId={batchId} />
        </div>
      </header>

      <div className="mb-3 flex items-center gap-4">
        <div
          role="progressbar"
          aria-valuenow={progress}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200"
        >
          <div
            className="h-full rounded-full bg-indigo-600 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="font-mono text-xs font-medium tabular-nums text-stone-500">
          {progress}%
        </span>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-stone-500">
        <span className="text-emerald-700">{batch.counts.succeeded} ok</span>
        <span className="text-stone-300">/</span>
        <span className={batch.counts.failed ? "text-rose-600" : "text-stone-400"}>
          {batch.counts.failed} failed
        </span>
        <span className="text-stone-300">/</span>
        <span className={batch.counts.cancelled ? "text-stone-600" : "text-stone-400"}>
          {batch.counts.cancelled} cancelled
        </span>
        <span className="text-stone-300">/</span>
        <span className="text-sky-600">{batch.counts.checking} checking</span>
        <span className="text-stone-300">/</span>
        <span className="text-stone-400">{batch.counts.queued} queued</span>
      </p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                URL
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                Status
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                HTTP
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                Time
              </th>
              <th className="hidden px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500 lg:table-cell">
                Title / error
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {batch.urls.map((url) => (
              <tr key={url.id} className="transition hover:bg-stone-50">
                <td
                  className="max-w-md truncate px-4 py-2.5 font-mono text-[12.5px] text-stone-700"
                  title={url.url}
                >
                  {url.url}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${URL_PILL[url.status]}`}
                  >
                    {STATUS_LABELS[url.status]}
                  </span>
                  {url.attempts > 1 && (
                    <span className="ml-1.5 font-mono text-[11px] text-stone-400">
                      try {url.attempts}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[13px] tabular-nums text-stone-700">
                  {url.httpStatus ?? "–"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[13px] tabular-nums text-stone-500">
                  {formatDuration(url.responseMs)}
                </td>
                <td
                  className="hidden max-w-lg truncate px-4 py-2.5 text-[13px] text-stone-500 lg:table-cell"
                  title={url.pageTitle ?? url.error ?? ""}
                >
                  {url.pageTitle ?? url.error ?? "–"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <ReanalyzeUrlButton batchId={batchId} urlId={url.id} size="sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
