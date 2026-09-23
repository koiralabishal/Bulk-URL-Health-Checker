"use client";

import { MAX_BATCH_SIZE } from "@urlchecker/shared";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createBatch } from "@/lib/api";

function normalize(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^https?:\/\//i.test(line) ? line : `https://${line}`));
}

function csvFirstColumn(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split(",")[0]?.trim().replace(/^"|"$/g, "") ?? "");
  const first = (rows[0] ?? "").toLowerCase();
  if (first === "url" || first === "urls" || first === "link" || first === "links") rows.shift();
  return rows.filter(Boolean);
}

export default function AnalyzeForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [urlsText, setUrlsText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const count = urlsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = csvFirstColumn(text);
      if (imported.length === 0) {
        setError("That file has no URLs in its first column.");
        return;
      }
      const existing = new Set(normalize(urlsText));
      const fresh = imported.filter((u) => !existing.has(u));
      const nextLines = [
        ...urlsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        ...fresh,
      ];
      if (nextLines.length > MAX_BATCH_SIZE) {
        setError(`Keeping the first ${MAX_BATCH_SIZE} URLs (limit per batch).`);
        setUrlsText(nextLines.slice(0, MAX_BATCH_SIZE).join("\n"));
      } else {
        setUrlsText(nextLines.join("\n"));
      }
      setFileName(file.name);
    } catch {
      setError("Could not read that file.");
    } finally {
      e.target.value = "";
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const urls = normalize(urlsText);
    if (urls.length === 0) {
      setError("Paste at least one URL, or upload a CSV.");
      return;
    }
    if (urls.length > MAX_BATCH_SIZE) {
      setError(`At most ${MAX_BATCH_SIZE} URLs per batch.`);
      return;
    }
    setSubmitting(true);
    try {
      const batchId = await createBatch(urls);
      router.push(`/batches/${batchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <label
          htmlFor="urls"
          className="text-xs font-semibold uppercase tracking-wider text-stone-400"
        >
          URLs to check
        </label>
        <span className="font-mono text-xs font-medium tabular-nums text-stone-400">
          {count}/{MAX_BATCH_SIZE}
        </span>
      </div>

      <textarea
        id="urls"
        value={urlsText}
        onChange={(e) => setUrlsText(e.target.value)}
        placeholder={
          "example.com\nhttps://example.com/pricing\nhttps://example.org/contact"
        }
        rows={8}
        spellCheck={false}
        disabled={submitting}
        className="w-full resize-y rounded-lg border border-stone-300 bg-white p-3.5 font-mono text-[13px] leading-relaxed text-stone-800 placeholder:text-stone-400 transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 disabled:opacity-60"
      />

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="cursor-pointer text-[13px] font-medium text-stone-500 underline-offset-2 hover:text-indigo-600 hover:underline">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={submitting}
              className="hidden"
            />
            {fileName ? `CSV: ${fileName}` : "Upload CSV"}
          </label>

          {urlsText && (
            <button
              type="button"
              onClick={() => {
                setUrlsText("");
                setFileName(null);
              }}
              disabled={submitting}
              className="text-[13px] font-medium text-stone-400 hover:text-stone-600"
            >
              Clear
            </button>
          )}

          {error && <span className="text-[13px] font-medium text-rose-600">{error}</span>}
        </div>

        <button
          type="submit"
          disabled={submitting || count === 0}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "Starting…"
            : `Analyze${count > 0 ? ` ${count}` : ""} URL${count === 1 ? "" : "s"}`}
        </button>
      </div>
    </form>
  );
}
