# Bulk URL Health Checker

A dashboard where you submit a list of URLs; a **separate worker process** checks each URL
in the background and records final HTTP status, response time, and page title. The UI
reflects progress **live over WebSockets** as results arrive.

Built to the take-home brief (`Take_Home_Task_Bulk_URL_Health_Checker.md`): required stack
is Node.js + TypeScript, Fastify, PostgreSQL, Redis, BullMQ, and Next.js - everything else
(schema, transport, layout) was our call and is defended below.

## Run it (one command)

Requirements: Node.js 20+, pnpm 10.

```bash
pnpm install
cp .env.example .env      # fill in your Neon + Upstash connection strings
pnpm db:migrate           # apply Drizzle migrations (see Services below)
pnpm dev                  # ← the one command that runs the whole system
```

- Web: http://localhost:3000 - `/` (submit), `/batches` (history), `/batches/:id` (live batch)
- API: http://localhost:3001 (REST + WebSocket)
- Worker: logs to the `worker` concurrently stream

> "One command" assumes a populated `.env`, because Postgres (Neon) and Redis (Upstash)
> are managed services rather than local containers. No Docker required.

### Services

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (`-pooler` host), used at runtime |
| `DATABASE_URL_DIRECT` | Optional: Neon **direct** connection string, preferred for migrations when set (falls back to `DATABASE_URL`) |
| `REDIS_URL` | Upstash TCP URL (`rediss://default:…@…:6379`) |
| `PORT` / `HOST` | API listen address (default `3001` / `0.0.0.0`) |
| `API_URL` | Used by Next.js server components to reach the API |
| `NEXT_PUBLIC_WS_URL` | Used by the browser to open the live socket (`ws://localhost:3001`) |

## Architecture overview

```text
                          ┌─────────────────────────────────────────────┐     
                          │              Browser (client)               │     
                          └──────────────┬──────────────────▲───────────┘     
                    HTTP: submit/cmds    │                  │ WebSocket
                                         ▼                  │ (snapshot-first:
                          ┌───────────────────────────┐     │  url_updated /  
                          │    Next.js Web  :3000     │     │  batch_updated) 
                          │    SSR pages + socket     │     │                 
                          └──────────────┬────────────┘     │                 
                      REST fetch (SSR)   │                  │
                                         ▼                  │
                                                            │
┌───────────────────────────────────────────────────────────│────────────────┐
│                            ┌──────────────────────────────┘                │
│   ┌────────────────────────┬───────────────────────┐                       │
│   │  Fastify API  :3001  (stateless, scale to N)   ◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐ │
│   │  REST commands  +  WebSocket fan-out           │ Redis pub/sub       │ │
│   │                                                │ batch:{id}          │ │
│   └───────┬─────────────────────┬──────────────────┘ batch:list          │ │
│           │ pg (pooled)         │ pg                                     │ │
│           ▼                     ▼                                        │ │
│   ┌──────────────────┐      ┌───┬────────────────────┐                   │ │
│   │   Worker  (n)    │      │    Neon PostgreSQL     │                   │ │
│   │      BullMQ      │      │    source of truth     │                   │ │
│   │     conc. 5      │      │   batches + url rows   │                   │ │
│   │    10 req/s *    │      │                        │                   │ │
│   └───────┬──────────┘      └────────────────────────┘                   │ │
│           │                                                              │ │
│           │                                                              │ │
│         ┌─┬──────────────────────────────────────────────────────┐       │ │
│         │  Upstash Redis                                         │       │ │
│         │  queue · rate limiter (Lua) · pub/sub · list cache     ├───────┘ │
│         └────────────────────────────────────────────────────────┘         │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

  *    10 req/s limiter lives in Redis → holds across every worker replica    
  ┄    dashed line = Redis pub/sub event fan-out (not request/response)       
```

- Three independent processes: **API**, **Worker**, **Web**. They share only types
  (`packages/shared`) and the two managed stores. No process can reach the database
  except through its own `packages/db` client.
- **Neon/Postgres is the single source of truth** (batches + per-URL rows). BullMQ/Redis
  holds jobs, not truth: after any crash or flush, the system rebuilds from Postgres.
- **Upstash/Redis** is coordination only: the BullMQ queue, the **global rate limiter**,
  WebSocket pub/sub fan-out, and the batch-list cache.

## Infrastructure decisions (why each piece, and what breaks without it)

| Piece | Role | What breaks without it |
|---|---|---|
| **Neon / Postgres** | Source of truth | No durable state → cold-open of a batch URL renders wrong, cancel/retry races, nothing survives a restart |
| **Upstash / Redis** | Queue + global limiter (Lua) + pub/sub + cache | The 10 req/s guarantee is enforced **in Redis and shared by every worker process**; without it each worker would happily do its own 10/s. Also no job delivery, no multi-instance live updates, no shared cache invalidation |
| **BullMQ** | Jobs, concurrency, retries/backoff, cancel of queued jobs | Without it we hand-roll at-least-once delivery, backoff, and idempotency-the exact failure modes this task tests |
| **Drizzle** | Typed SQL + generated migrations | Migration integrity; guarded updates become raw string SQL and the idempotency story rots |
| **WebSockets** | Live propagation | Polling (lag/latency) or SSE (we'd lose control of reconnect semantics) |

Drizzle runs against the **pooled** Neon string at runtime. Migrations prefer the
**direct** string when `DATABASE_URL_DIRECT` is set: Neon's pooler is PgBouncer in
transaction mode, so DDL should go through the direct connection (and `LISTEN/NOTIFY`
isn't available there-one more reason live updates ride on Redis pub/sub, not Postgres).

## The three guarantees, and how they are enforced

1. **Global rate limit 10 req/s across all workers**
   `limiter: { max: 10, duration: 1000 }` on the BullMQ `Worker`. BullMQ decrements a
   shared Redis-backed counter via a Lua script; every worker process draws from the
   same pool, so the ceiling holds with 1 or 10 worker replicas.
2. **Concurrency 5**-`concurrency: 5` per worker.
3. **Retries ≤ 3, exponential backoff, transient failures only**
   `attempts: 3` + `backoff: { type: "exponential", delay: 1000 }`. Transient =
   network error / timeout / HTTP 429 / 5xx. Other 4xx are permanent (`/bad` in the
   verification suite lands `failed` after exactly 1 attempt, never retried).

### Idempotency

- **Deterministic job IDs**: `jobId = batchId:urlId:runSeq`. Re-enqueueing a duplicate
  is a no-op; retry/re-analyze bumps `runSeq` to mint fresh job IDs.
- **Guarded updates**: every state transition is `UPDATE … WHERE status = <expected>`.
  A redelivered job that finds its row already terminal no-ops at the database layer.
- **Handler re-reads before writing**-replaying any job is safe by construction.
- Batch creation + URL inserts share one transaction; jobs are enqueued only after commit.

## Live updates (WebSockets)

Chosen transport: **WebSockets over Redis pub/sub**, defended against the alternatives
in `plan.md` and the trade-off notes below.

- Two routes: `WS /api/batches/:id/socket` (detail page) and `WS /api/batches/socket`
  (shared history channel `batch:list`). The worker/API publish to `batch:{id}` and
  `batch:list` on Upstash; **every API instance subscribes and fans out to its local
  sockets**-any instance can serve any client, so WebSockets scale horizontally.
- **Protocol** (`packages/shared`): server always sends a full `snapshot` on
  (re)connect, then `url_updated` / `batch_updated` increments. Client heartbeats with
  `ping`/`pong`; a missing pong forces a reconnect.
- **Refresh safe / cold open**: `GET /batches/:id` renders a full SSR snapshot (server
  component, `cache: 'no-store'`), so a brand-new tab shows correct state whether the
  batch is running or finished. The WebSocket only layers incremental events on top.
- **Dropped connection**: the client reconnects with exponential backoff and receives a
  fresh snapshot on every open, closing any event gap. Reconnecting to a *different*
  API instance is harmless-state comes from Neon, events from Redis.
- **Why WebSockets over SSE/polling**: full-duplex when we need a client→server control
  plane, a single long-lived connection we fully control on both ends, and disconnect
  detection via heartbeats (SSE's built-in reconnect is exactly what we *don't* want —
  we validate state on reconnect instead).

## Type safety across the boundary

- `packages/shared` holds **zod** schemas for every API response and every WebSocket
  envelope. Fastify handlers parse/validate against them (compile-time types via
  `z.infer`, runtime enforcement via zod), and the Next.js client/server components
  consume the same package. `packages/db` feeds typed Drizzle rows into `packages/shared`
  DTOs at the API boundary. The client never sees SQL shapes and no interface is
  duplicated by hand.

## UI

Function over form (per the brief-auth, notifications, and charts are out of scope):

- `/`-submit a batch: paste a URL list or upload a CSV (first column; a `url` header
  row is skipped), then jump straight to the new batch.
- `/batches`-list of all batches (paginated), served from the 30s cache over SSR and
  kept current by the shared list socket.
- `/batches/:id`-single batch, addressable and cold-open-safe: SSR snapshot first,
  then live row updates, progress, and controls (Cancel / Retry failed / Re-analyze /
  per-row Re-run).

## Controls

All controls live in the UI and on the REST API; in every case the **persisted state is
written first**, then jobs/notifications follow-the user never sees a state Postgres
doesn't have.

- **Cancel** (`POST /api/batches/:id/cancel`): commits the state change in Postgres
  *first* (batch → `cancelled`, queued/checking rows → `cancelled`), then removes the
  batch's queued/delayed BullMQ jobs. Anything in flight finds its guarded update no-ops,
  so persisted state can never disagree with what the user sees.
- **Retry failed only** (`POST /api/batches/:id/retry-failed`, UI button
  `Retry failed (N)`): selects `failed` rows, resets them to `queued`, re-enqueues with
  the next `runSeq`; successes are untouched.
- **Re-analyze** (batch or single URL): full fresh run (`runSeq` bump, stale jobs
  dropped, row metrics reset). Per-row **Re-run** on the batch page is the single-URL
  version.

## Caching

`GET /api/batches` is served from **versioned keys** under `cache:batches:list` with a
30s TTL:

- Reads capture the current version (`cache:batches:list:ver`) and load
  `cache:batches:list:v{N}:p{page}:s{size}`.
- Every mutation (batch create/cancel/retry/re-analyze, each URL completion from the
  worker) **increments the version** on shared Redis-all old page keys become
  unreachable at once for every API instance.
- Writes are compare-and-set against the version captured at read, so a concurrent
  invalidation can't republish a stale snapshot under the new version.

The TTL is only a backstop; correctness comes from the version bump, so no API instance
can show stale data after a change in a user-visible way.

## Verification (the guarantees in practice)

`pnpm verify` runs `scripts/verify.mjs` (needs the stack running): it stands up a local
"recorder" server whose request log is used to assert:

- global rate ≤ **10 requests in every 1000 ms window**
- concurrency ≤ **5 in flight**
- a URL that 502s twice is retried 3× (exponential backoff) then succeeds
- a 404 URL fails after exactly 1 attempt
- page titles captured on success
- cancelling mid-flight leaves every row terminal and consistent with the batch

All checks pass against the live system (`pnpm dev` + `pnpm verify`).

## Horizontal scaling

How the system behaves when processes are scaled out-no code changes required:

| Process | Scale-out behavior |
|---|---|
| **API** | Stateless REST + WS fan-in. Each instance subscribes to Redis pub/sub and fans out to its local sockets, so **any instance can serve any client**. No sticky sessions: a reconnect to a different instance pays a fresh `snapshot` and catches up from there. The 30s list cache is versioned **on shared Redis**, so an invalidation from instance A is observed by instance B on the next read. |
| **Worker** | The 10 req/s limiter lives in Redis (Lua), shared by every replica-throughput stays capped at 10/s no matter how many workers you run. Concurrency 5 is **per worker**, so N workers give up to 5N in-flight checks, still gated by the same global rate limit. Job claims are guarded at the DB, so duplicate deliveries no-op. |
| **Web** | Stateless SSR behind any load balancer; sockets reconnect with snapshot-first, so instances don't need shared memory. |

Try it while the stack runs (2 API + 2 workers):

```bash
pnpm -F @urlchecker/api dev & pnpm -F @urlchecker/api dev & pnpm -F @urlchecker/worker dev & pnpm -F @urlchecker/worker dev
```

Guarantees hold unchanged: the limiter, queue, cache, and pub/sub all live in shared
Upstash; state lives in Neon; replicas are stateless.

## Assumptions & trade-offs (recorded per the brief)

- "Transient failure" = network error, timeout, HTTP 429, HTTP 5xx. Other 4xx are
  permanent and never retried.
- Title = first-`<title>` regex over the first 64 KB of the HTML body, truncated to 500
  chars, entities decoded. No full-body download.
- Cancel discards an in-flight result (guarded update no-ops) instead of aborting the
  socket mid-request.
- Batch size is capped at 1,000 URLs per request (documented, arbitrary safe bound).
- Worker `attempts` column counts check attempts across retries and is never reset —
  "attempts" therefore reflects real network attempts, not just the generation.
- Rate limit is **global**, so adding workers increases concurrency (pipeline depth),
  not request throughput-polite by design.
- Live events use Redis **pub/sub** (fire-and-forget): a Redis blip can drop an event,
  which is safe because every (re)connect starts from a Postgres-backed snapshot.
  Durable streams would be the upgrade path (see below).
- List cache is 30s TTL + version-bump invalidation: HTTP readers may miss a WS tick,
  but never see a state the DB no longer has after a mutation returns.
- **Upstash cost note**: BullMQ issues periodic housekeeping commands, which are metered
  on Upstash's pay-as-you-go plan. A **Fixed plan** is recommended for sustained use.
- **CSV upload**: one URL per line; the first column is used (label,url supported); a
  `url` header line is skipped.
- Out of scope per the brief (intentionally not built): auth, notifications, charts.
  Visual design is not an evaluation axis, but the UI is a clean, functional Tailwind
  surface so the live behavior is easy to follow.

### What I'd change with more time

- Persistent WebSocket fan-out via Redis streams + consumer groups (instead of simple
  pub/sub) so events survive a brief Redis outage between worker and API.
- Stream-backed audit log of every state transition for replay/debugging.
- Scroll-virtualized URL table for very large batches (1,000 rows render fine today;
  10k+ would want virtualization).
- Dedicated migration connection pinning (and `LISTEN/NOTIFY` on a non-pooler runtime)
  as a second live-update path alongside Redis.
- Auth / multi-tenant batches (explicitly out of scope for this task).

## Repo layout

```text
bulk-url-health-checker/
├── apps/
│   ├── api/                    # Fastify-REST commands + WebSocket fan-out
│   │   └── src/
│   │       ├── routes.ts       # create · list · detail · cancel · retry · re-analyze
│   │       ├── ws.ts           # snapshot-first sockets (detail + shared list)
│   │       ├── cache.ts        # versioned 30s batch-list cache
│   │       ├── events.ts       # Redis pub/sub publish
│   │       └── queue.ts        # BullMQ queue + deterministic jobIds
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts        # Worker: concurrency 5 · limiter 10/s · claims
│   │       └── check.ts        # fetch · transient/permanent classification · title
│   └── web/
│       └── src/
│           ├── app/
│           │   ├── page.tsx                # / submit form (paste / CSV)
│           │   ├── batches/page.tsx        # /batches history list
│           │   └── batches/[id]/page.tsx   # /batches/:id cold-open SSR snapshot
│           ├── components/     # BatchLive · BatchesHistory · actions · form
│           └── lib/            # api client · use-batch-socket · use-batches-socket
├── packages/
│   ├── shared/                 # zod wire schemas + shared constants (types)
│   └── db/                     # Drizzle schema + pg client + migrations
├── scripts/
│   └── verify.mjs              # live proof of rate / concurrency / retry / cancel
├── .env.example
├── package.json                # pnpm dev · verify · typecheck · db:migrate
└── README.md
```
