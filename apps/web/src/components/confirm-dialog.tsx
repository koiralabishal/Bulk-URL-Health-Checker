"use client";

import { useEffect } from "react";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="absolute inset-0 bg-stone-900/50 backdrop-blur-[2px]"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />
      <div className="relative w-full max-w-md rounded-xl border border-stone-200 bg-white p-5 text-left shadow-xl">
        <h2
          id="confirm-dialog-title"
          className="text-left text-base font-bold text-stone-900"
        >
          {title}
        </h2>
        <p className="mt-2 text-left text-sm leading-relaxed text-stone-600">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-stone-300 bg-white px-3.5 py-1.5 text-sm font-medium text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
