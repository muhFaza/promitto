# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Promitto is a self-hosted WhatsApp message scheduler. One VPS, one container, SQLite, Baileys. No SaaS, no signup, admin-provisions users. Prod: `https://wa.muhfaza.my.id`.

## Commands

Everything runs in Docker; you don't need Node on the host.

```bash
cp backend/.env.example backend/.env       # defaults are fine for SQLite dev
docker compose up --build                  # backend :3000, frontend :5173

docker compose exec backend  npm run typecheck   # tsc --noEmit
docker compose exec backend  npm run lint        # eslint .
docker compose exec frontend npm run typecheck
docker compose exec frontend npm run lint

docker compose exec backend npm run db:generate  # after editing db/schema.ts
docker compose exec backend npm run db:migrate

docker compose exec backend npm run cli:create-superuser
docker compose exec backend npm run cli:reset-superuser-password
```

**There is no test framework.** No `test` script, no runner, no `*.test.ts` anywhere — so there is no "run a single test". Verification is `typecheck` + `lint` + exercising the app. If you add tests, you are also picking the runner; say so rather than assuming one exists.

`backend/scripts/test-*.ts` are **not** tests — they are non-interactive stand-ins for the `@inquirer/prompts` CLIs (which need a TTY), e.g. `tsx scripts/test-seed-superuser.ts <email> <password>`.

Dev-compose gotcha: `backend/node_modules` is a named volume. After changing `backend/package.json`, run `docker compose run --rm backend npm install` or rebuild — otherwise the volume masks the new deps.

## Architecture

### One process, three long-lived things

`backend/src/main.ts` starts the Express server, then `sessionManager.restoreAll()`, `sessionManager.startSupervisor()` and `schedulerPoller.start()`, and tears all four down on SIGTERM/SIGINT. `process.exit(1)` handlers for `unhandledRejection`/`uncaughtException` log the cause first — without them a stray rejection killed the process with no log line at all.

`process.umask(0o077)` is the first *statement*, so every file the process creates at runtime (SQLite DB, Baileys creds) is private by default. Note it is **not** in force during module evaluation: ESM hoists all `import`s above it, so anything created at import time predates it. Nothing currently relies on that — `db/client.ts` `chmodSync`s the DB/WAL/SHM explicitly, and auth state is written well after boot — but don't add import-time file creation and assume the umask covers it.

Both the poller and the `SessionManager` are **module-level singletons holding in-memory state** (open sockets, tick locks). This is why replicas are forbidden — two processes would double-send and fight over the same WA sockets.

### Request path

`server.ts` → `requestLogger` → `express.json({limit:'1mb'})` → `cookieParser` → `/api/health` → six routers → `errorMiddleware`. No CORS middleware: dev goes through Vite's `/api` proxy (`VITE_PROXY_TARGET`), prod is same-origin because the same Express process serves `frontend/dist` with an SPA fallback for any non-`/api` GET.

`/api/health` returns `{status, db, sessions, wa: {expected, connected, lastCheckAt}}`. `wa.lastCheckAt` is the last supervisor tick (epoch ms, `null` before the first): an idle tick logs nothing, so without it a wedged supervisor looks exactly like a healthy one. Stale by more than ~60s means nothing is watching the sessions any more. **`status` is driven by the DB ping alone, deliberately** — `deploy.yml` greps for `"status":"ok"` to decide whether to roll back, and a fresh container legitimately takes ~13s to restore its WhatsApp sessions, so a WA-aware `status` would roll back every deploy. `wa.expected` vs `wa.connected` is the signal instead: divergence means the container is up and serving while WhatsApp is dead, which went unnoticed for 1h15m in Aug 2026. The endpoint must never throw — a 500 here trips the rollback.

Routers and their gating (`A` = `requireAuth`, `P` = `requirePasswordRotated`, `C` = `requireCsrf`, applied via `router.use(...)`):

| Mount | Gate | Notes |
|---|---|---|
| `/api/auth` | none (`/me` uses `A`) | `login`, `logout`, `me` — both POSTs are deliberately CSRF-exempt |
| `/api/users` | `A` + `P` + `C` + `requireSuperuser` | list/create/disable/enable/reset-password/delete |
| `/api/wa` | `A` + `P` + `C` | `connect`, `disconnect`, `logout`, `status`, `events` (SSE) |
| `/api/contacts` | `A` + `P` + `C` | list (search, limit capped 200), `recent` (pinned + interaction recency, limit capped 50), create, rename/pin (one PATCH, ≥1 key), delete |
| `/api/scheduler` | `A` + `P` + `C` | create, list (`?status=upcoming\|recurring\|history\|failed`), `stats`, `preview`, patch, cancel |
| `/api/settings` | `A` + `C`, `P` per-route | password, timezone, timezone list (`GET /timezones` un-gated by `P` on purpose) |

Every module follows `routes.ts` (zod parsing + HTTP) → `service.ts` (Drizzle, synchronous better-sqlite3). Services take `userId` as the first argument and scope every query by it — that per-query `userId` filter *is* the tenancy boundary; there is no row-level security underneath it.

### Wire conventions

- **Errors**: throw `errors.*()` from `lib/errors.ts`; `errorMiddleware` renders `{ error: { code, message, details? } }`. Bare `ZodError` is auto-converted to a 400 `validation_error`. The frontend's `apiRequest` unwraps that envelope into an `ApiError`.
- **Timestamps**: SQLite stores `timestamp_ms` integers; serializers (`lib/scheduled-message.ts`, `lib/contact.ts`, `lib/user.ts`) emit **epoch-ms numbers**, never ISO strings. The frontend formats with luxon in the user's TZ.
- **Never return a raw DB row** — go through the serializer, or you leak `passwordHash`, `pickedAt`, and friends.

### Data model (`backend/src/db/schema.ts`)

`users` → `sessions`, `wa_connections` (PK is `user_id`, so one WA number per user by construction), `contacts` (unique on `user_id + jid`), `scheduled_messages`, `sent_messages`. All child tables cascade on user delete. Migrations are Drizzle SQL files in `backend/drizzle/`; the prod entrypoint applies them before the server boots, so **every migration must be backward-compatible with the previous release** in case of rollback.

`sent_messages` is an append-only attempt log, one row per send attempt (success *and* failure) — it is not a mirror of `scheduled_messages`. "History" and "Failed" in the UI are both reads of this table.

`contacts.pinned_at` / `contacts.last_interaction_at` are both nullable. `listRecent()` orders pinned first (`pinned_at ASC` — repeat pin deliberately keeps the original timestamp so the order is stable), then `COALESCE(last_interaction_at, newest scheduled_messages.created_at per recipient) DESC`; unpinned rows with neither signal are excluded. `recordInteractions()` is UPDATE-only and monotonic — it never creates contacts and never regresses a newer timestamp.

### Frontend

Vite + React 18 + Zustand v5 + React Router v6. All routes live under `/app` behind `RequireAuth` (`requireSuperuser` for `/app/admin`); `/` and `*` redirect to `/app`. State lives in five Zustand stores (`auth`, `contacts`, `schedule`, `ui`, `wa`); `api/*` wraps `apiRequest`, and `api/sse.ts` wraps `EventSource`.

Compose lives on the **Dashboard**, not on `/app/schedule` — the Schedule page is list-only and links back to `/app#compose`.

## Scheduler invariants

Read `modules/scheduler/{poller,service}.ts` together before touching either.

- **Atomic claim**: `pickDue()` runs inside `BEGIN IMMEDIATE`, selects rows where `is_active = 1 AND next_run_at <= now AND picked_at IS NULL`, stamps `picked_at = now`, commits. There is no `state` column — `picked_at` *is* the lease. Every terminal path in `service.ts` must reset `picked_at = null`.
- **Lease recovery**: a crash between claim and record would strand `picked_at` and make the row invisible to `pickDue()` forever, so `poller.start()` calls `releaseStaleLeases()` before the first tick. Single-instance means any lease present at boot is orphaned by definition — the same reasoning as `resetOrphanQrPending()` on the WA side. It logs at `warn` when it clears anything, which is your signal the last shutdown was unclean.
- **Tick**: 30s, plus one immediate tick at boot; ≤50 rows per tick; a `ticking` flag makes overlapping ticks a no-op, and rows are processed **sequentially**, not in parallel.
- **Jitter**: 2–8s random sleep before each send (`lib/jitter.ts`), inside the sequential loop — a full tick of 50 messages therefore takes minutes by design.
- **Retries**: `MAX_RETRIES = 3` counts *total* attempts, so there are only two retries, at 30s and 2m. The third entry of `BACKOFF_MS` (10m) is unreachable dead config — don't cite it as behaviour.
- **On exhaustion**: `once` → `is_active = false`. `recurring` → skip to the next natural cron occurrence and reset `retry_count` (a recurring schedule never dies from send failures, only from a cron expression that stops parsing, which deactivates it).
- **Timezones**: per-user IANA, stored on the row at create time. `next_run_at` is computed by cron-parser in that TZ and persisted as UTC ms.
- Editing is only allowed while `is_active`; `once` rows take `nextRunAt` and reject `cronExpression`, `recurring` rows take `cronExpression` and reject `nextRunAt` (it is always derived).

## WhatsApp / Baileys (`modules/wa-sessions/manager.ts`)

`SessionManager` keeps a `Handle` per user: socket, status, latest QR, an `EventEmitter` that feeds the `/api/wa/events` SSE stream, and reconnect bookkeeping. DB (`wa_connections`) is the durable mirror; the handle is the truth while the process lives.

- Pinned exact at `7.0.0-rc14` (no caret) — rc12 fixed CVE-2026-48063. `sock.end()` returns a `Promise` as of rc14, so every call site must `await` it or `shutdown()` returns before the sockets are actually closed. It pulls in `whatsapp-rust-bridge` (WASM, prebuilt — no native toolchain, and the builder no longer needs `git` now that `libsignal` comes from npm).
- Call `fetchLatestWaWebVersion()` before `makeWASocket()` (cached process-wide) — hardcoded versions go stale and break the Noise handshake.
- Auth state = `backend/data/sessions/{userId}`, **0700 dir / 0600 files**, re-chmod'd on every `creds.update`. Don't loosen this; Baileys creds are as sensitive as the WA session itself.
- **WA closes sockets with no statusCode.** `message === 'disconnected'` and `statusCode === undefined` is normal server-side drop, not a logout. (rc14 now wraps most of its own closes in Boom — `connectionClosed` 428 and `connectionLost` 408 — so a bare `undefined` is rarer than it used to be. Only 401 is branched on, so this doesn't change behaviour.)
- **Two-tier reconnect.** Fast ladder in the close handler: `2^n` capped 60s, `MAX_RECONNECT_ATTEMPTS = 7` → 1,2,4,8,16,32,60s ≈ 123s. Exhausting it writes `failed` but is **not terminal** — the supervisor takes over. Every close and every scheduled attempt logs; before this existed a drop logged nothing at all, which is why the Aug 2026 incident could not be reconstructed.
- **The supervisor is the backstop.** `startSupervisor()` runs a `reconcile()` every 60s comparing DB intent (`listRestorable()`) against live sockets, and reopens anything stranded — backoff 60s→15min with jitter, and it never permanently gives up. It exists because *any* missed path (a timer lost to a process death, an unhandled close) used to strand a session until a human pressed Connect. Warns once a session is down >5min, re-warning every 15min.
- **Two statusCodes are special-cased.** `restartRequired` (515) is a routine post-pair instruction, so it reconnects on a 1s floor without spending a ladder rung — budget capped at 3 and only refilled once a connection has held `STABLE_CONNECTION_MS`, or an open→515 flap loops forever. `connectionReplaced` (440) means another WhatsApp Web login took over: it stops dead at `disconnected` (deliberately not supervisor-eligible) because retrying fights the other session and repeated conflicts can get the number flagged.
- **A socket only counts while it owns the handle.** `handleConnectionUpdate` takes the socket it was registered for and ignores events from any socket that is no longer `h.sock` (or is in `h.abandonedSocks`). Without that guard a dying socket's close nulls `h.sock` out from under the *live* one — and a stale 401 reaches `wipeAuthState()` and revokes credentials the live socket is still using.
- **`reconnectAttempts` must reset on manual `connect()` and `disconnect()`** (and does on `'open'`) — otherwise a user who hits the cap can never recover from the UI.
- **`shutdown()` and `disconnect()` MUST set `intentionalClose = true` before `sock.end()`.** Otherwise the close handler treats it as a drop, flips the DB row to `connecting`, and the next boot shows a phantom connecting state with no socket behind it.
- **`restoreAll()` restores `connected` + `connecting` + `failed`** (`RESTORABLE_STATUSES` in `wa-sessions/service.ts` — one definition, also used by the supervisor and `/api/health`). All three mean "credentials on disk are valid and the owner's intent is to be connected". It calls `resetOrphanQrPending()` first, which resets **only** `qr_pending` — a QR nobody is watching is genuinely dead. `disconnected` is an explicit user choice and `logged_out` had its auth dir revoked, so neither is restored.
  - This is the fix for the Aug 2026 incident: a heap-OOM death lands the row on `connecting` (GC thrash starves the keepalive, so the socket drops seconds *before* the process dies), and the old `clearOrphanConnecting()` rewrote that to `disconnected` and then restored only `connected` — so the session was unrecoverable by construction. WhatsApp was down 1h15m behind a green health check.
  - `connecting` rows keep their `lastError` on purpose. Blanking it destroyed the only record of why the socket dropped.
  - Restore and the supervisor both check `creds.json` exists first (ENOENT only — a transient EACCES/EIO must not de-register a session), so a credential-less row can't spend a pairing attempt emitting a QR nobody scans.
- Contact sync is **opportunistic and stateless**: `contacts.upsert`/`contacts.update` fire post-pair and each is upserted immediately. There is no "sync complete" event and no done-detection — don't build UI that waits for one.
- Interaction recency is captured the same way: `messaging-history.set` / `chats.upsert` / `chats.update` / `messages.upsert` feed a per-user `(jid, epoch-ms)` buffer (same debounce + hard cap as contact sync) flushed via UPDATE-only `recordInteractions()`. Handlers are synchronous extraction only — never retain chat/message objects (heap is capped at 195 MB). Baileys timestamps arrive in **seconds** as `number|Long|null`; `waTsToMs()` normalizes. WhatsApp replays chat history only at pair time, so on an already-paired session this data accrues from live traffic — the scheduling-history fallback in `listRecent()` covers the gap.
- Only `^[0-9]+@s\.whatsapp\.net$` passes `isUserJid()`; groups (`@g.us`) are rejected at the router. Phone input is normalized by `libphonenumber-js` with **`ID` as the default region** (`0812…` and `62812…` both → `+62812…`).
- The `jid` stored on `wa_connections` is `normalizeOwnJid()`'d to a bare `+62…` phone string, not a real JID. Contact/recipient JIDs are the real thing.
- `BAILEYS_LOG_LEVEL` (default `silent`) surfaces Baileys' socket lifecycle in prod without a rebuild.

## Auth model

- Passwords → Argon2id (`lib/password.ts`).
- Sessions → opaque random token in an HttpOnly cookie named `promitto_sid`, **HMAC-SHA256-signed** with `SESSION_SECRET` (`lib/cookie-signer.ts`), 30-day duration. Rotating `SESSION_SECRET` invalidates every session by design.
- `requireAuth`: `readSignedSessionId()` → `getSessionWithUser()` → reject if `user.disabledAt` → `touchSession()` → `setCsrfCookie()` → populate `req.user` / `req.session`. `touchSession()` slides `expiresAt` to `now + 30d`, and the CSRF cookie's `maxAge` is re-emitted on every safe-method request so the two TTLs never drift apart.
- **CSRF**: session-bound double-submit. `lib/csrf.ts` HMACs the session id with `CSRF_SECRET` into a non-HttpOnly `promitto_csrf` cookie (the frontend must read it); `requireCsrf` compares it against the `X-CSRF-Token` header with `timingSafeEqual` on every unsafe method. **Applied at router level** (`router.use(requireAuth, requirePasswordRotated, requireCsrf)`), so routes added later inherit it — keep it that way rather than gating per-route. `CSRF_SECRET` falls back to `SESSION_SECRET` when unset; set it distinct in prod to separate the HMAC keyspace.
- Two deliberate CSRF exemptions: `POST /api/auth/login` (no session exists yet) and `POST /api/auth/logout` (a missing cookie must not strand a live server-side session — Safari ITP, privacy mode).
- **Multi-device is supported on purpose.** Login does *not* revoke other live sessions — it only reaps that user's expired rows, inside one `sqlite.transaction().immediate()` with the insert. Admin actions (disable / delete / reset-password) still revoke everything; changing your own password revokes every session *except* the current one.
- `touchSession()` slides `expiresAt` but clamps it to `createdAt + ABSOLUTE_SESSION_MAX_MS` (90d). Without that ceiling a sliding window never expires, and since login no longer revokes other sessions, this cap **is** the bound on a leaked cookie.
- **Temp-password gate**: `users.must_change_password` is set on admin-issued temp passwords and cleared on password change. `requirePasswordRotated` returns 403 `MUST_CHANGE_PASSWORD` on gated routes; `RequireAuth` redirects to `/app/settings`. `GET /api/settings/timezones` is deliberately **un**gated so the dropdown still populates for a gated user.
- Login is rate-limited by two in-memory token buckets (`modules/auth/rate-limit.ts`): per-IP 20 burst / 1 per 2s, per-email 5 burst / 1 per 30s. In-memory means **a restart clears them** and `TRUST_PROXY` must be on in prod or every request shares Traefik's IP.

## Frontend design system

Aesthetic: **"quiet utility ledger"** — warm paper + ink, deliberate typography, hairline borders instead of cards-with-shadows. Keep it that way.

- **Palette** (`tailwind.config.js`): `paper` / `paper-raised` / `paper-deep`, `ink` / `ink-soft` / `ink-muted`, `rule` / `rule-strong`, `accent` (olive — live/success), `accent-warm` (terracotta — destructive/failed), `amber-soft` (warnings). No `slate-*`, `emerald-*`, or `red-*` — use the tokens.
- **Fonts** (Google Fonts, `index.html`): `font-display` → Fraunces (variable serif, italic for H1/H2/section titles), `font-sans` → Geist, `font-mono` → Geist Mono.
- **Mono is reserved for machine-generated data**: timestamps, JIDs, phone numbers, cron expressions, emails. Never for prose, hints, error text, badge labels, or tab labels.
- **Structure**: hairline rules (`border-rule`, `<hr>`) separate sections. Cards use `.ledger-card`; eyebrows use `.eyebrow` (both in `index.css`). No rounded-xl or drop-shadow defaults.
- **Motion**: CSS-only (`animate-fadeInUp`, `animate-ping` on pending WA status). Don't add framer-motion.

## Scope — do not expand

- **Single instance.** Never run replicas. If you outgrow one VPS, rewrite (Redis + BullMQ + leader election) — don't retrofit.
- **Text messages only.** No media, templates, broadcasts, or groups.
- **One WhatsApp number per user**, enforced by the `wa_connections` primary key.
- **No signup, no password recovery, no email flows.** Superuser-provisioned only; temp passwords are shown once. Superuser reset is CLI-only, deliberately.
- **Hard sends are warnings, not caps.** The UI warns at ≥10 pending or on any recurring create — it never blocks.

## Production

Single container behind Traefik v3.2 on the shared external `web` network, TLS via the `le` certresolver, HSTS middleware, `TRUST_PROXY=true`. The image builds the frontend and backend in separate stages and runs as `node`; the entrypoint runs `db:migrate` then `node dist/main.js`. Everything stateful is the `./backend/data` bind mount: `promitto.db` (WAL) plus every user's Baileys auth state.

**Deploys are automated.** Pushing to `main` (anything but Markdown) runs `.github/workflows/deploy.yml`: build on the runner → rotate `promitto:deploy` to `promitto:previous` → `docker save | gzip | ssh 'docker load'` → scp the compose file → `up -d` → poll `/api/health`, rolling back to `promitto:previous` if it never goes green. `workflow_dispatch` deploys the current `main` on demand.

Deployed at `~/promitto` on the personal VPS. **Read `../CLAUDE.md` (and `~/CLAUDE.md` on the server) before touching the deployment** — that is where host-level rules live; don't duplicate them here. Promitto-specific points:

- **`docker-compose.prod.yml` has no `build:` key on purpose.** The box has ~960MB RAM and Node builds have been OOM-killed on it. `up -d --build` will fail, and that is the guard working — build elsewhere for `linux/amd64` and ship the image in. `mem_limit: 384m` matches how every other service on the box is capped.
- The container holds a **live paired WhatsApp session**, and every deploy restarts it — but that does **not** normally cost a re-pair. The pairing lives in `backend/data/sessions/{userId}/` on the bind mount and outlives the container; only the socket is disposable. Measured 2026-08-11 on a real `up -d --force-recreate`: `SIGTERM` → `Closed cleanly.` in 389ms (40s `stop_grace_period`, unused), then `wa session restored` **13.3s** after the new container started. So the true cost is ~13s of WhatsApp downtime with no phone interaction. Batching merges is still sensible, just not urgent.
  - This works because `shutdown()` deliberately **does not write status** — the row stays `connected`, and `restoreAll()` selects exactly `status = 'connected'`. Do not "tidy up" `shutdown()` by having it mark rows disconnected: that silently breaks QR-free restore, and nothing will fail until the next deploy.
  - A QR re-pair is only needed when the restore *fails*. Real causes: a 401 `loggedOut`, corrupt or partial auth writes, unlinking the device from the phone, or two sockets sharing one set of creds.
  - **`wipeAuthState()` renames, it does not delete.** A 401 moves the auth dir to `<dir>.revoked-<timestamp>` rather than `rm -rf`ing it. Given there are no backups, a spurious 401 used to mean permanent, unrecoverable credential loss; now the directory can be renamed back. Nothing prunes those — they accumulate, deliberately. Delete one only when you're sure the session is genuinely gone.
  - `useMultiFileAuthState` writes creds with a plain `writeFile` — no temp file, no atomic rename — so a SIGKILL mid-write can truncate `creds.json` and cost a re-pair. That is why the process is tuned to stay inside the cgroup rather than get OOM-killed (see `NODE_OPTIONS` below).
  - ⚠️ **That last cause is why blue-green / zero-downtime deploys are not an option here** — they would cause the very failure they're meant to avoid. Overlapping containers would share the Baileys creds (WhatsApp treats concurrent use as a conflict and can invalidate the session) and both would run the scheduler poller, double-sending every due message. Accept the ~13s. The only real fix is splitting the session holder into its own long-lived container, which is a rewrite and out of scope — see "Scope — do not expand".
- **There are no backups — none scheduled, and the deploy takes none.** Removed deliberately on 2026-08-10 at the owner's instruction; the archives and the cron are gone. `deploy/backup.sh` still exists as a manual tool if you ever want a snapshot, but nothing invokes it.
- **Rolling the image back does not roll the schema back, and there is nothing to restore from.** A destructive or non-backward-compatible migration is therefore unrecoverable — it takes the accounts, contacts, schedules, and every paired WhatsApp session with it. This raises the bar on migration review considerably; treat it as the primary risk in any schema change.
- Losing `sessions/{userId}/` costs that user a re-pair; losing `promitto.db` costs all accounts, contacts, and schedules.

### Memory — the Aug 2026 heap deaths

The process died of `FATAL ERROR: Reached heap limit` every ~72h. Diagnosis, so nobody re-derives it:

- **V8 sizes its heap from *host* RAM, not the cgroup.** On this 965MB box it picked ~259MB — *below* `mem_limit: 384m`, so Node self-aborted before Docker's limit ever applied and `docker inspect` reported `OOMKilled: false`. The memory problem was invisible from outside the container. `NODE_OPTIONS: --max-old-space-size=192` now pins it: deterministic, and low enough that native allocations (Node baseline, new-space, better-sqlite3, the `whatsapp-rust-bridge` WASM linear memory) stay inside 384m. Raise it and `mem_limit` together, never alone.
- **The actual churn was `chmodAuthState()`**, which walked the *entire* auth dir on every `creds.update` — ~10k files in production, measured at 801ms and +18.5MB per run, ~6 runs/hour. It's now once per directory per process (`sweptAuthDirs`), with only `creds.json` re-chmodded per save. The memory was always reclaimed, so this was allocation churn and old-space fragmentation rather than a classic retention leak.
- Ruled out with evidence: the SSE endpoint tears down both its listener and its ping interval on `req`/`res` close (and no `MaxListenersExceededWarning` ever appeared), rate-limit buckets evict, the contact buffer is capped at 200. Known upstream Baileys leaks in the rc line don't apply — this app never subscribes to `messages.upsert` and is text-only.
- Still unproven: whether a slow ~2.7MB/h retention leak also exists. Settling it needs `--heapsnapshot-near-heap-limit=1` and a crash to catch. **This matters much less now** — a crash no longer strands the session, because boot restore and the supervisor recover it automatically.
- `lid-mapping-*` and `migratedSessionCache` in Baileys rc14 are TTL-only with no entry cap, and the TTL is 72h. Suggestive given the 72h30m crash, but single-digit MB — a coincidence worth remembering, not a proven cause.

## Breaks silently if you miss it

- `SESSION_SECRET` must be ≥32 chars — the zod env schema `process.exit(1)`s at boot otherwise, and there is no other validation layer. `CSRF_SECRET` has the same floor but is **optional** and falls back to `SESSION_SECRET`, so an existing deployment without it still boots.
- The service worker must **never** cache `/api/*` (`frontend/public/sw.js`) — stale scheduler state is worse than none. Shell-only: cache-first for `/assets/`, network-first for navigations.
- Empty Zustand generic arg trips the eslint empty-type rule — use the v5 curried form: `create<State>()((set) => …)`.
- Drizzle 0.36.x index API: return a plain object from the table callback, `(t) => ({ idx: index(...) })`, not an array.
- Traefik's `exposedByDefault=false` means the `web` network and the labels must both be present, or the container simply isn't routed.
- `@inquirer/prompts` needs a TTY — anything piping stdin must use the `scripts/test-*` helpers instead.
- **`backend/.env` must exist before any `docker compose` command**, including `typecheck` and `lint` — the dev compose file declares `env_file`, so compose aborts before your command runs if it's missing. `cp backend/.env.example backend/.env` first. To check types without one: `docker build -q -t promitto-backend-check -f backend/Dockerfile.dev backend && docker run --rm promitto-backend-check sh -c "npm run typecheck && npm run lint"`.
