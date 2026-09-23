import { MAX_TITLE_LENGTH } from "@urlchecker/shared";

export type CheckOutcome =
  | { ok: true; httpStatus: number; responseMs: number; title: string | null }
  | { ok: false; transient: boolean; httpStatus: number | null; error: string };

const USER_AGENT = "bulk-url-health-checker/1.0";
const TIMEOUT_MS = 10_000;
const BODY_LIMIT_BYTES = 64 * 1024;

export async function checkUrl(url: string): Promise<CheckOutcome> {
  let res: Response;
  const started = performance.now();
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        // One-shot checks: never reuse pooled keep-alive sockets, which can go stale
        // (e.g. the target restarts or the OS tears the connection down).
        connection: "close",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const cause = err instanceof Error ? (err as Error & { cause?: Error }).cause : undefined;
    const detail = cause?.message ? ` (${cause.message})` : "";
    return {
      ok: false,
      transient: true,
      httpStatus: null,
      error: aborted ? `timeout after ${TIMEOUT_MS}ms` : `network error: ${(err as Error).message}${detail}`,
    };
  }
  const responseMs = Math.round(performance.now() - started);

  // Transient statuses: throttle (429) and server errors (5xx).
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, transient: true, httpStatus: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  }
  // Permanent client errors: never retried.
  if (res.status >= 400) {
    return { ok: false, transient: false, httpStatus: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  }

  const title = await extractTitle(res).catch(() => null);
  return { ok: true, httpStatus: res.status, responseMs, title };
}

async function extractTitle(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total >= BODY_LIMIT_BYTES) break;
  }
  text += decoder.decode();

  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (!match?.[1]) return null;

  return match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH) || null;
}