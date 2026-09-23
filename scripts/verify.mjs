/**
 * End-to-end verification: proves the rate limit, concurrency, retry, and cancel
 * guarantees against a live API + worker + Neon + Upstash stack.
 *
 * Usage:
 *   1) Start the system (pnpm dev) with real creds in .env
 *   2) node scripts/verify.mjs            # defaults to http://localhost:3001
 *
 * It spins up a local "recorder" HTTP server whose endpoints let us measure
 * exactly when and how many requests the worker makes, then asserts:
 *   - global rate ≤ 10 requests in any 1000ms window
 *   - concurrency ≤ 5 in flight
 *   - transient 502 retried 3x then succeeded
 *   - permanent 404 marked failed after exactly 1 attempt
 *   - cancel turns every non-terminal URL cancelled and batch → cancelled
 */
import http from "node:http";

const API = process.env.API_URL ?? "http://localhost:3001";
// Fixed ports get churned by consecutive runs and can intermittently refuse connects
// (Windows socket teardown). Let the OS pick a free port instead; it is stable for
// the whole run since the recorder lives in this process.
const RECORDER_HOST = "127.0.0.1";
let RECORDER_PORT;
// No tolerance: the limiter's guarantee is exactly ≤10 per 1000ms sliding window,
// and widening the window here would admit an 11th request that is within spec.
const TOLERANCE_MS = 0;

const reqLog = [];
let concurrent = 0;
let maxConcurrent = 0;
const flakyAttempts = new Map();

function titleFor(path) {
  return `<title>Checks: ${path}</title>`;
}

const recorder = http.createServer((req, res) => {
  const path = req.url ?? "/";
  reqLog.push({ path, at: Date.now() });

  concurrent += 1;
  maxConcurrent = Math.max(maxConcurrent, concurrent);

  const respond = (status, body) => {
    concurrent -= 1;
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };

  if (path.startsWith("/slow")) {
    setTimeout(() => respond(200, `<html><head>${titleFor(path)}</head><body>ok</body></html>`), 1200);
    return;
  }
  if (/^\/flaky/.test(path)) {
    const n = (flakyAttempts.get(path) ?? 0) + 1;
    flakyAttempts.set(path, n);
    respond(n <= 2 ? 502 : 200, `<html><head>${titleFor(path)}</head><body>ok</body></html>`);
    return;
  }
  if (/^\/bad/.test(path)) {
    respond(404, "<html><body>gone</body></html>");
    return;
  }
  respond(200, `<html><head>${titleFor(path)}</head><body>ok</body></html>`);
});

let passed = 0;
let failed = 0;
const results = [];
function check(name, ok, detail) {
  ok ? (passed += 1) : (failed += 1);
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function api(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const data = await res.json();
  return { status: res.status, data };
}

async function createBatch(urls) {
  const { status, data } = await api("/api/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  if (status !== 200) throw new Error(`create failed: ${status} ${JSON.stringify(data)}`);
  return data.batchId;
}

async function waitForTerminal(batchId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api(`/api/batches/${batchId}`);
    if (data.status === "completed" || data.status === "cancelled") return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`batch ${batchId} did not reach terminal state within ${timeoutMs}ms`);
}

async function main() {
  await new Promise((resolve, reject) => {
    recorder.once("error", reject);
    recorder.listen(0, RECORDER_HOST, resolve);
  });
  RECORDER_PORT = recorder.address().port;
  const base = `http://${RECORDER_HOST}:${RECORDER_PORT}`;
  console.log(`\nrecorder listening on ${base} — API under test: ${API}\n`);

  // ---- 1. Rate + concurrency + retries + permanent failures ----
  console.log("== batch 1: rate, concurrency, retry semantics ==");
  const normalNb = 20;
  const urls = [
    ...Array.from({ length: normalNb }, (_, i) => `${base}/rate/${i}`),
    `${base}/flaky`,
    `${base}/bad`,
  ];
  const batchId = await createBatch(urls);
  const detail = await waitForTerminal(batchId);

  const terminal = detail.status === "completed";
  check("batch completed", terminal, `status=${detail.status}`);

  const failures = detail.urls.filter((u) => u.status === "failed");
  check("only the permanent 404 is failed", failures.length === 1 && failures[0].url.endsWith("/bad"), `${failures.length} failed rows`);
  check("bad row has attempts=1 and 404", failures[0]?.attempts === 1 && failures[0]?.httpStatus === 404, `attempts=${failures[0]?.attempts} http=${failures[0]?.httpStatus}`);

  const flakyRow = detail.urls.find((u) => u.url.endsWith("/flaky"));
  check("flaky (2x502) retried then succeeded", flakyRow?.status === "succeeded" && flakyRow.attempts >= 3, `status=${flakyRow?.status} attempts=${flakyRow?.attempts}`);

  const okRows = detail.urls.filter((u) => u.status === "succeeded");
  check("ok rows carry title", okRows.every((u) => u.pageTitle && u.pageTitle.includes("Checks:")), `${okRows.length} titled rows`);

  // ---- rate window analysis over the same run's request log ----
  const times = reqLog.map((r) => r.at).sort((a, b) => a - b);
  let maxInWindow = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > 1000 + TOLERANCE_MS) left++;
    maxInWindow = Math.max(maxInWindow, right - left + 1);
  }
  check("global rate ≤ 10 requests/1000ms", maxInWindow <= 10, `max=${maxInWindow} in 1000ms window (${reqLog.length} requests)`);
  check("concurrency ≤ 5 in flight", maxConcurrent <= 5, `max concurrent=${maxConcurrent}`);

  // ---- 2. Cancel semantics ----
  console.log("\n== batch 2: cancel mid-flight ==");
  const slowNb = 15;
  const cancelId = await createBatch(Array.from({ length: slowNb }, (_, i) => `${base}/slow/${i}`));
  await new Promise((r) => setTimeout(r, 1500)); // let the first wave go in-flight
  await api(`/api/batches/${cancelId}/cancel`, { method: "POST" });
  const cancelled = await waitForTerminal(cancelId);

  check("batch cancelled", cancelled.status === "cancelled", `status=${cancelled.status}`);
  const stillChecking = cancelled.urls.filter((u) => u.status === "checking" || u.status === "queued");
  check("no queued/checking rows remain", stillChecking.length === 0, `${stillChecking.length} non-terminal rows`);
  const allTerminal =
    cancelled.urls.every((u) => ["succeeded", "failed", "cancelled"].includes(u.status));
  check("every row terminal and consistent with batch", allTerminal, `${cancelled.urls.length} rows`);

  await new Promise((resolve) => recorder.close(resolve));

  console.log(`\n==========`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verification error:", err);
  process.exit(1);
});