# Bulk URL Health Checker — Architecture Plan

## 1. Overview
A dashboard where a user submits a list of URLs; a **separate background worker process** checks each URL and records final HTTP status, response time, and page title. The UI reflects progress **live over WebSockets**. Commands are REST; events are WebSocket. Postgres is the single source of truth; Redis/Upstash is queue + coordination + cache only.

**Stack:** Next.js + TS · Fastify + TS · Drizzle ORM + Neon (Postgres) · BullMQ + Upstash Redis (ioredis) · WebSockets (`@fastify/websocket`)

## 2. Process topology — separation is structural
Three independent processes/containers; no cross-imports between them except shared types:
```
browser ──HTTP/WS──▶ Fastify API (n replicas, stateless)
                          │                          │
                    REST commands                 WS fan-out
                          │                          │
                              ▼                         ▼
                    NEON Postgres (source of truth)   UPSTASH Redis
                    • batches / batch_urls            • BullMQ queue
                    • idempotent guarded writes       • global limiter (Lua)
                    • snapshots for cold-open         • pub/sub channels
                                                      • list cache
                              ▲                         ▲
                          results (pg)              jobs + events
                              └──────────── Worker (n replicas, stateless) ◀┘
                                          concurrency 5, 10 req/s global
```
- **API** serves REST + accepts WS upgrades; owns no job state.
- **Worker** consumes BullMQ jobs; owns no HTTP surface; writes state only to Neon.
- **Web** (Next.js) renders; reaches data only through the API's HTTP/WS boundary (never direct DB access), which keeps the UI process independent and testable.

## 3. Persistence — Neon + Drizzle (source of truth)
- `packages/db` — Drizzle `pg-core` schema:
  - `batches`: `uuid` PK, `status` enum `pending|running|completed|cancelled`, `totalCount`, `createdAt`, `updatedAt`
  - `batch_urls`: `uuid` PK, `batchId` FK (cascade), `url`, `status` enum `queued|checking|succeeded|failed|cancelled`, `httpStatus`, `responseMs`, `pageTitle`, `attempts`, `error`, `finishedAt`, `UNIQUE(batchId,url)`
- Client: `drizzle(node-postgres Pool)` with the **pooled** Neon string (`-pooler`) at runtime; `max` sized low (no double pooling).
- Migrations: `drizzle-kit migrate` against **`DATABASE_URL_DIRECT`** (Neon's PgBouncer transaction mode cannot run DDL), run as a one-shot compose service whose success gates `api`/`worker`.
- Progress = derived `COUNT(*) GROUP BY status` over `(batch_id)` index — no counter columns that can drift.

### Where the source of truth lives
**Neon Postgres owns batch and per-URL lifecycle state.** BullMQ/Redis, queues, caches, and pub/sub channels are transient coordination — if Upstash is wiped, all job/queue/live-update machinery is lost but the system self-heals (re-enqueue, snapshot refetch) and every snapshot renders correctly. If Neon is unavailable, nothing renders correctly. Cancel/retry are committed to Postgres **first**, so the persisted state always equals what the user sees even if cleanup of the queue lags.

## 4. Background processing — BullMQ on Upstash, ioredis
- `ioredis` factory from Upstash `rediss://` URL:
  - Worker/blocking connections: **`maxRetriesPerRequest: null`** (BullMQ requirement).
  - API queue client: bounded retries (fail fast to the caller).
  - Pub/sub subscriber: `redis.duplicate()`; no `keyPrefix`.
- Queue `url-check`, job payload `{ batchId, urlId, runSeq }`, **jobId = `urlId:runSeq`**.
- **Rate limit / concurrency / retry:**
  - **10 req/s global**: `limiter: { max: 10, duration: 1000 }`. BullMQ enforces limits with a **Redis Lua script shared by all workers**, so it holds across the cluster — one worker, five workers, same 10/s ceiling. This is the concrete reason Redis/Upstash exists.
  - **Concurrency 5**: `concurrency: 5` per worker; controllers honor the shared limiter.
  - **Retries ≤3**: `attempts: 3` + exponential backoff, **transient only** (network error, timeout, 429, 5xx). Permanent failures (other 4xx, invalid URL) use `UnrecoverableError` → no wasted retries → `failed`.
- Check loop: `fetch` + `AbortSignal.timeout(10_000)`, follow redirects, record **final** status code, wall-clock `responseMs`, `<title>` from first 64KB (truncated).
- After each URL: guarded UPDATE → publish to Upstash `batch:{id}` (Pub/Sub needs no PgBouncer, which also rules out `LISTEN/NOTIFY`).

### Idempotency
1. Deterministic **jobId per generation** → duplicate enqueue is a no-op; retry-failed uses `runSeq+1`.
2. **Guarded updates**: every transition is `UPDATE … SET … WHERE id = ? AND status = <expected>`. A duplicate or late delivery matching a terminal status no-ops (row count 0).
3. Handler re-reads DB before working — re-running any job is safe by construction.
4. Batch creation and URL inserts share one `db.transaction()`.

## 5. API — Fastify (REST commands, WS events)
| Endpoint | Purpose |
|---|---|
| `POST /api/batches` | zod-validated URLs or CSV (`@fastify/multipart`) → one insert transaction → enqueue jobs → `{ batchId }`; `DEL cache:batches:list` |
| `GET /api/batches` | Redis `cache:batches:list` (EX 30); miss → DB → `SET`; any mutation `DEL`s the key on the shared store → no cross-instance staleness (TTL is only a backstop) |
| `GET /api/batches/:id` | full snapshot (batch + all URL rows) — cold-open source, `no-store` |
| `POST /api/batches/:id/cancel` | **Neon first**: batch → `cancelled`, non-terminal URLs → `cancelled`; then `queue.getJobs(['waiting','delayed'])` → `job.remove()` for that batch; in-flight jobs discard their result at a pre-persist batch-status check; invalidate + publish event |
| `POST /api/batches/:id/retry-failed` | select `failed` rows → reset to `queued` → re-enqueue with `runSeq+1` jobIds; succeeded rows untouched; invalidate + publish event |
| `WS /api/batches/:id/socket` | live updates |

### Live updates — WebSockets
- `@fastify/websocket` on the same Fastify port. Worker publishes to Upstash `batch:{id}`; **every API instance subscribes and fans out to its local sockets** → any instance serves any client; horizontal scaling is free.
- **Protocol** (typed JSON in `packages/shared`):
  - Server→client: `{type:'snapshot',…}` on **every** (re)connect, then `{type:'url_updated',…}`, `{type:'batch_finished'|'batch_cancelled'}`.
  - Client→server: `{type:'ping'}` heartbeat.
- **Dropped connection recovery**: WS has no built-in reconnect (unlike EventSource) so it is explicit — `useBatchSocket` reconnects with exponential backoff and **requests a fresh snapshot on every open**; heartbeats detect dead sockets (no pong → reconnect). Missed events are closed by the snapshot. Landing on a different instance after reconnect is harmless (snapshot-first). Proxies only need to forward Upgrade headers; no sticky sessions.
- **Defense of choice:** bidirectional, single long-lived connection, we control wire discipline on both ends; commands stay REST (addressable, idempotent HTTP), WS carries events only.

## 6. UI — Next.js (deliberate server/client split)
- `/batches` — **server component**: reads the API list endpoint server-side → links. Client JS not needed for this view.
- `/batches/[id]` — **server component**: fetches the full snapshot server-side (`cache: 'no-store'`) → **correct on cold open (new tab, no prior state), whether running or finished**, zero-JS first paint.
- `BatchLive` — small **client component** mounted under the SSR snapshot: opens the WS, merges `url_updated` events onto the snapshot, drives the progress bar; heartbeat + reconnect; closes the socket on unmount.
- Why this is deliberate, not default: snapshot ownership is server-side (correctness/addressability/linking), live-ness is client-side (events), and the two never fight because incremental events are layered strictly on top of a fresh snapshot. No `useEffect` fetching full data client-side, no double-source-of-truth.

## 7. Type safety
- `packages/shared` holds **zod** schemas for every API response and every WebSocket envelope → `z.infer` types.
- Fastify validates request bodies and response payloads against the same schemas (`fastify-type-provider-zod`) → the wire contract is enforced at runtime, not just compile time.
- Drizzle `$inferSelect` row types feed query results; rows are mapped to shared DTOs only at the API boundary — the client never sees SQL shapes.
- Worker and Web both import the same `packages/shared` — no duplicated interfaces anywhere.

## 8. Why each piece, and what breaks without it
| Piece | Role | What breaks without it |
|---|---|---|
| **Neon/Postgres** | Source of truth | No durable state → no refresh-safe UI, no correct cancel/retry, nothing survives a restart |
| **Upstash Redis** | Queue + **global limiter (Lua)** + pub/sub + cache | Without it there is no cross-process 10 req/s guarantee (each worker would do its own 10/s), no reliable background job delivery, no multi-instance live updates, no shared cache invalidation |
| **BullMQ** | Jobs, concurrency, retries/backoff, cancel-of-queued | Without it we'd hand-roll at-least-once delivery, backoff, and dedupe — error-prone and non-distributed |
| **Drizzle** | Typed, auditable query layer + migrations | Without it we hand-write SQL strings → type drift and unguarded updates reopen idempotency gaps |
| **WebSockets** | Live propagation | Without it: polling (lag + load) or SSE (asymmetric, weaker reconnect semantics we don't control) |
| **Separate worker container** | Isolation + scaling | A combined api+worker process means a burst of checks stalls HTTP, and is unverifiable against the limiter |

## 9. Verification strategy — proving the guarantees in practice
Wired into the repo as scripts + a README procedure, since the task explicitly checks "hold in practice":
- **Rate limit (10/s global):** run **two worker processes** (`--scale worker=2`) against a local recorder; worker logs each request timestamp + source; assert ≤10 in any 1000 ms window across the cluster (script with tolerances). Run the same with one worker to prove the ceiling is deliberately global, not per-process.
- **Concurrency = 5:** recorder introduces a fixed 500 ms delay; assert never >5 in flight (`concurrency` + `active` counters dumped by the worker).
- **Retries:** a flaky-test harness URL fails transiently (e.g., first 2 attempts return 502) → assert `attempts` goes 1→2→3 and the row lands `succeeded`; a permanent 404 → lands `failed` with `attempts = 1`.
- **Idempotency:** replay a completed job (same `jobId`, redelivery) → assert row count and status unchanged.
- **Resilience:** kill a client mid-batch → reconnect + snapshot produces identical UI state; app-level reconnect test → state self-heals from Neon.

## 10. Infra / one command
- `docker-compose.yml`: `migrate` → `api`, `worker`, `web`. `cp .env.example .env` (Neon pooled + direct, Upstash `rediss://`) → `docker compose up --build`. README states plainly: *one command + a populated `.env`* because DB/Redis are managed.
- Horizontal scaling (`--scale api=2 worker=2`) is safe by construction: limiter/queue/cache/pub-subs share Upstash, state shares Neon, API/worker are stateless.
- Upstash cost note: BullMQ issues periodic commands → prefer a **Fixed plan** over pay-per-command.

## 11. Assumptions (recorded in README)
- Transient = network error / timeout / 429 / 5xx; other 4xx are permanent (no retry).
- Title = regex over first 64KB of HTML, truncated to 500 chars.
- Cancel discards the in-flight result rather than aborting the socket.
- Batch size cap 1000 URLs (safe bound; unlimited rows otherwise).

## 12. Build order (3 days)
1. **Day 1** — scaffold monorepo, compose, `.env.example`, Drizzle schema on Neon, `POST /batches` + worker; run the rate/concurrency/retry verification scripts (Section 9).
2. **Day 2** — snapshot endpoint, WS + Upstash pub-sub fan-in, cancel + retry-failed, cache + invalidation.
3. **Day 3** — Next.js pages + `BatchLive`, cold-open and reload-mid-batch tests, reconnect/resilience test, README (architecture, trade-offs, horizontal scaling, what we'd change with more time), Loom script.