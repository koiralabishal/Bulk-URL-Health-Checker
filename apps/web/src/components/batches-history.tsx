"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteBatchButton, ReanalyzeBatchButton, RetryFailedButton } from "@/components/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { deleteBatches } from "@/lib/api";
import { BATCH_STATUS_LABELS, formatDate, progressOf } from "@/lib/format";
import { useBatchesSocket } from "@/lib/use-batches-socket";
import type { BatchesPage } from "@urlchecker/shared";

const PILL: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  running: "bg-sky-50 text-sky-700 ring-sky-600/20",
  pending: "bg-stone-100 text-stone-600 ring-stone-500/15",
  cancelled: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

function PagerLink({
  page,
  current,
  children,
}: {
  page: number;
  current: number;
  children: React.ReactNode;
}) {
  const base =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium transition";
  if (page < 1) {
    return <span className={`${base} text-stone-300`}>{children}</span>;
  }
  if (page === current) {
    return <span className={`${base} bg-stone-900 text-white`}>{children}</span>;
  }
  return (
    <Link
      className={`${base} text-stone-600 hover:bg-stone-100 hover:text-stone-900 hover:no-underline`}
      href={`/batches?page=${page}`}
    >
      {children}
    </Link>
  );
}

function Pagination({ page, totalPages, total }: { page: number; totalPages: number; total: number }) {
  if (totalPages <= 1) return null;

  const pages = new Set<number>([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
  const visible = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  return (
    <nav className="mt-5 flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
      <PagerLink page={page - 1} current={page}>
        ← Prev
      </PagerLink>
      {visible.map((p, i) => {
        const prev = i > 0 ? visible[i - 1] : undefined;
        return (
          <span key={p} className="inline-flex items-center gap-1">
            {prev !== undefined && p - prev > 1 && <span className="px-1 text-stone-300">…</span>}
            <PagerLink page={p} current={page}>
              {p}
            </PagerLink>
          </span>
        );
      })}
      <PagerLink page={page + 1} current={page}>
        Next →
      </PagerLink>
      <span className="ml-3 text-xs text-stone-400">{total} total</span>
    </nav>
  );
}

export default function BatchesHistory({ initial }: { initial: BatchesPage }) {
  const { page: live, connected } = useBatchesSocket(initial);
  const router = useRouter();
  const totalPages = Math.max(1, Math.ceil(live.total / live.pageSize));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const allIds = live.items.map((b) => b.id);
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
      await deleteBatches([...selected]);
      setBulkConfirmOpen(false);
      clearSelection();
      router.refresh();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Bulk delete failed");
      setBulkBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-black tracking-tight">History</h1>
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? "animate-pulse bg-emerald-500" : "bg-stone-300"
              }`}
              title={connected ? "Live — streaming updates" : "Reconnecting…"}
            />
            {connected && <span className="text-xs font-medium text-stone-400">live</span>}
          </div>
          <p className="mt-1 text-sm text-stone-500">
            {live.total} batch{live.total === 1 ? "" : "es"} · page {live.page} of {totalPages}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {someSelected && (
            <>
              <span className="text-xs font-medium text-stone-500">
                {selected.size} selected
              </span>
              <button
                type="button"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkBusy}
                className="rounded-md border border-rose-300 bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                title={bulkError ?? "Delete selected batches"}
              >
                {bulkBusy ? "Deleting…" : `Delete selected (${selected.size})`}
              </button>
              <ConfirmDialog
                open={bulkConfirmOpen}
                title={`Delete ${selected.size} batch${selected.size === 1 ? "" : "es"}?`}
                message={`Delete ${selected.size} batch${selected.size === 1 ? "" : "es"} and all their URLs? This cannot be undone.`}
                confirmLabel="Delete"
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
                className="rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
              >
                Clear
              </button>
            </>
          )}
          <Link
            href="/"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 hover:no-underline"
          >
            New analysis
          </Link>
        </div>
      </div>

      {live.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-16 text-center">
          <h2 className="text-lg font-bold text-stone-900">No batches yet</h2>
          <p className="mt-1.5 text-sm text-stone-500">
            Run your first check and it will appear here.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 hover:no-underline"
          >
            Analyze URLs
          </Link>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
            <table className="w-full min-w-[900px]">
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
                      aria-label="Select all batches on this page"
                      className="h-3.5 w-3.5 rounded border-stone-300 accent-indigo-600"
                    />
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    Batch
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    Progress
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    Results
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                    Created
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {live.items.map((batch) => {
                  const progress = progressOf(batch);
                  return (
                    <tr
                      key={batch.id}
                      className={`transition hover:bg-stone-50 ${
                        selected.has(batch.id) ? "bg-indigo-50/40" : ""
                      }`}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(batch.id)}
                          onChange={() => toggleOne(batch.id)}
                          aria-label={`Select batch ${batch.id.slice(0, 8)}`}
                          className="h-3.5 w-3.5 rounded border-stone-300 accent-indigo-600"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/batches/${batch.id}`}
                          className="font-mono text-[13px] font-semibold text-indigo-600 hover:underline"
                        >
                          {batch.id.slice(0, 8)}
                        </Link>
                        <div className="text-xs text-stone-400">{batch.totalCount} URLs</div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${PILL[batch.status] ?? PILL.pending}`}
                        >
                          {BATCH_STATUS_LABELS[batch.status]}
                        </span>
                      </td>
                      <td className="w-48 px-4 py-3">
                        <div
                          role="progressbar"
                          aria-valuenow={progress}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200"
                        >
                          <div
                            className="h-full rounded-full bg-indigo-600 transition-all duration-500"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <div className="mt-1 font-mono text-[11px] tabular-nums text-stone-400">
                          {progress}%
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5 font-mono text-[11px] font-medium tabular-nums">
                          <span className="text-emerald-700">{batch.counts.succeeded} ok</span>
                          <span className="text-stone-300">/</span>
                          <span className={batch.counts.failed ? "text-rose-600" : "text-stone-400"}>
                            {batch.counts.failed} failed
                          </span>
                          {batch.counts.cancelled > 0 && (
                            <>
                              <span className="text-stone-300">/</span>
                              <span className="text-stone-400">
                                {batch.counts.cancelled} cancelled
                              </span>
                            </>
                          )}
                          {batch.counts.queued + batch.counts.checking > 0 && (
                            <>
                              <span className="text-stone-300">/</span>
                              <span className="text-sky-600">
                                {batch.counts.queued + batch.counts.checking} pending
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] text-stone-500">
                        {formatDate(batch.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-nowrap items-center gap-2">
                          <Link
                            href={`/batches/${batch.id}`}
                            className="whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 hover:no-underline"
                          >
                            View
                          </Link>
                          <RetryFailedButton
                            batchId={batch.id}
                            failedCount={batch.counts.failed}
                            size="sm"
                          />
                          <ReanalyzeBatchButton batchId={batch.id} size="sm" />
                          <DeleteBatchButton batchId={batch.id} size="sm" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination page={Math.min(live.page, totalPages)} totalPages={totalPages} total={live.total} />
        </>
      )}
    </div>
  );
}
