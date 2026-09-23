"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  cancelBatch,
  deleteBatch,
  deleteUrl,
  reanalyzeBatch,
  reanalyzeUrl,
  retryFailed,
} from "@/lib/api";

function useAction(action: () => Promise<void>, refresh: boolean) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (refresh) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}

const sizeClass = (size: "sm" | "md") =>
  size === "sm" ? "whitespace-nowrap px-2.5 py-1 text-xs" : "whitespace-nowrap px-3.5 py-1.5 text-sm";

export function ReanalyzeBatchButton({
  batchId,
  size = "md",
}: {
  batchId: string;
  size?: "sm" | "md";
}) {
  const { busy, error, run } = useAction(() => reanalyzeBatch(batchId), true);
  return (
    <button
      type="button"
      className={`rounded-md border border-stone-300 bg-white font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
      disabled={busy}
      title={error ?? "Re-run every URL in this batch"}
      onClick={run}
    >
      {busy ? "Starting…" : "Re-analyze"}
    </button>
  );
}

export function ReanalyzeUrlButton({
  batchId,
  urlId,
  size = "sm",
}: {
  batchId: string;
  urlId: string;
  size?: "sm" | "md";
}) {  const { busy, error, run } = useAction(() => reanalyzeUrl(batchId, urlId), true);
  return (
    <button
      type="button"
      className={`rounded-md border border-stone-300 bg-white font-medium text-stone-600 transition hover:border-indigo-400 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
      disabled={busy}
      title={error ?? "Re-check this URL"}
      onClick={run}
    >
      {busy ? "…" : "Re-run"}
    </button>
  );
}

export function CancelBatchButton({
  batchId,
  size = "md",
}: {
  batchId: string;
  size?: "sm" | "md";
}) {
  const { busy, error, run } = useAction(() => cancelBatch(batchId), true);
  return (
    <button
      type="button"
      className={`rounded-md border border-rose-200 bg-white font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
      disabled={busy}
      title={error ?? "Stop the remaining queued checks"}
      onClick={run}
    >
      {busy ? "Cancelling…" : "Cancel"}
    </button>
  );
}

/**
 * Re-runs ONLY the URLs that ended `failed` (API: retry-failed). Successful
 * work is never redone. Renders nothing when there is nothing to retry.
 */
export function RetryFailedButton({
  batchId,
  failedCount,
  size = "md",
}: {
  batchId: string;
  failedCount: number;
  size?: "sm" | "md";
}) {
  const { busy, error, run } = useAction(() => retryFailed(batchId), true);
  if (failedCount <= 0) return null;
  return (
    <button
      type="button"
      className={`rounded-md border border-amber-300 bg-white font-medium text-amber-700 transition hover:border-amber-400 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
      disabled={busy}
      title={error ?? `Re-run only the ${failedCount} failed URL(s) — successes stay untouched`}
      onClick={run}
    >
      {busy ? "Retrying…" : `Retry failed (${failedCount})`}
    </button>
  );
}

/**
 * Permanently deletes the batch and all of its URL rows (cascade).
 * When `redirect` is set (detail page), navigates back to History after delete.
 */
export function DeleteBatchButton({
  batchId,
  size = "md",
  redirect = false,
  confirmMessage = "Delete this batch and all of its URLs? This cannot be undone.",
  onDeleted,
}: {
  batchId: string;
  size?: "sm" | "md";
  redirect?: boolean;
  confirmMessage?: string;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBatch(batchId);
      setOpen(false);
      onDeleted?.();
      if (redirect) router.push("/batches");
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`rounded-md border border-rose-200 bg-white font-medium text-rose-600 transition hover:border-rose-400 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
        disabled={busy}
        title={error ?? "Permanently delete this batch"}
        onClick={() => setOpen(true)}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
      <ConfirmDialog
        open={open}
        title="Delete batch?"
        message={confirmMessage}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={confirm}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
      />
    </>
  );
}

/** Permanently deletes one URL row from a batch. */
export function DeleteUrlButton({
  batchId,
  urlId,
  size = "sm",
  onDeleted,
}: {
  batchId: string;
  urlId: string;
  size?: "sm" | "md";
  onDeleted?: (result: { batchDeleted?: boolean }) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deleteUrl(batchId, urlId);
      setOpen(false);
      onDeleted?.(res);
      if (res.batchDeleted) router.push("/batches");
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`rounded-md border border-rose-200 bg-white font-medium text-rose-600 transition hover:border-rose-400 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass(size)}`}
        disabled={busy}
        title={error ?? "Remove this URL"}
        onClick={() => setOpen(true)}
      >
        {busy ? "…" : "Delete"}
      </button>
      <ConfirmDialog
        open={open}
        title="Delete URL?"
        message="Remove this URL from the batch? This cannot be undone."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={confirm}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
      />
    </>
  );
}
