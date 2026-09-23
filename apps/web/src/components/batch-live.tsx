"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CancelBatchButton,
  DeleteBatchButton,
  DeleteUrlButton,
  ReanalyzeBatchButton,
  ReanalyzeUrlButton,
  RetryFailedButton,
} from "@/components/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { deleteUrls } from "@/lib/api";
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
  const router = useRouter();
  const progress = progressOf(batch);
  const active = batch.status === "running" || batch.status === "pending";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const allIds = batch.urls.map((u) => u.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const clearSelection = () => setSelected(new Set());

  const runBulkDelete = async () => {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await deleteUrls(batchId, [...selected]);
      setBulkConfirmOpen(false);
      clearSelection();
      if (res.batchDeleted) router.push("/batches");
      else router.refresh();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Bulk delete failed");
      setBulkBusy(false);
    }
  };

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
        <div className="flex flex-wrap items-center gap-2">
          <RetryFailedButton batchId={batchId} failedCount={batch.counts.failed} />
          {active && <CancelBatchButton batchId={batchId} />}
          <ReanalyzeBatchButton batchId={batchId} />
          <DeleteBatchButton batchId={batchId} redirect />
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

      {someSelected && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <span className="text-xs font-semibold text-rose-700">
            {selected.size} URL{selected.size === 1 ? "" : "s"} selected
          </span>
          <button
            type="button"
            onClick={() => setBulkConfirmOpen(true)}
            disabled={bulkBusy}
            className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={bulkError ?? "Remove selected URLs from this batch"}
          >
            {bulkBusy ? "Removing…" : `Remove selected (${selected.size})`}
          </button>
          <ConfirmDialog
            open={bulkConfirmOpen}
            title={`Remove ${selected.size} URL${selected.size === 1 ? "" : "s"}?`}
            message={`Remove ${selected.size} URL${selected.size === 1 ? "" : "s"} from this batch? This cannot be undone.`}
            confirmLabel="Remove"
            busy={bulkBusy}
            onConfirm={runBulkDelete}
            onCancel={() => {
              if (!bulkBusy) setBulkConfirmOpen(false);
            }}
          />
          <button
            type="button"
            onClick={clearSelection}
            disabled={bulkBusy}
            className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-100"
          >
            Clear
          </button>
          {bulkError && <span className="text-xs text-rose-600">{bulkError}</span>}
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
        <table className="w-full min-w-[1000px]">
          <thead>
            <tr className="border-b border-stone-200">
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all URLs"
                  className="h-3.5 w-3.5 rounded border-stone-300 accent-indigo-600"
                />
              </th>
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
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                Title / error
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {batch.urls.map((url) => (
              <tr
                key={url.id}
                className={`transition hover:bg-stone-50 ${
                  selected.has(url.id) ? "bg-indigo-50/40" : ""
                }`}
              >
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(url.id)}
                    onChange={() => toggleOne(url.id)}
                    aria-label={`Select ${url.url}`}
                    className="h-3.5 w-3.5 rounded border-stone-300 accent-indigo-600"
                  />
                </td>
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
                  className="max-w-lg truncate px-4 py-2.5 text-[13px] text-stone-500"
                  title={url.pageTitle ?? url.error ?? ""}
                >
                  {url.pageTitle ?? url.error ?? "–"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex flex-nowrap items-center gap-1.5">
                    <ReanalyzeUrlButton batchId={batchId} urlId={url.id} size="sm" />
                    <DeleteUrlButton batchId={batchId} urlId={url.id} size="sm" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
