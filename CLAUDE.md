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

`backend/src/main.ts` starts the Express server, then `sessionManager.restoreAll()` and `schedulerPoller.start()`, and tears all three down on SIGTERM/SIGINT. `process.umask(0o077)` is set as the very first statement, before any import, so every file the process creates (SQLite DB, Baileys creds) is private by default.

Both the poller and the `SessionManager` are **module-level singletons holding in-memory state** (open sockets, tick locks). This is why replicas are forbidden — two processes would double-send and fight over the same WA sockets.

### Request path

`server.ts` → `requestLogger` → `express.json({limit:'1mb'})` → `cookieParser` → `/api/health` → six routers → `errorMiddleware`. No CORS middleware: dev goes through Vite's `/api` proxy (`VITE_PROXY_TARGET`), prod is same-origin because the same Express process serves `frontend/dist` with an SPA fallback for any non-`/api` GET.

Routers and their gating (`A` = `requireAuth`, `P` = `requirePasswordRotated`, `C` = `requireCsrf`, applied via `router.use(...)`):

| Mount | Gate | Notes |
|---|---|---|
| `/api/auth` | none (`/me` uses `A`) | `login`, `logout`, `me` — both POSTs are deliberately CSRF-exempt |
| `/api/users` | `A` + `P` + `C` + `requireSuperuser` | list/create/disable/enable/reset-password/delete |
| `/api/wa` | `A` + `P` + `C` | `connect`, `disconnect`, `logout`, `status`, `events` (SSE) |
| `/api/contacts` | `A` + `P` + `C` | list (search, limit capped 200), create, rename, delete |
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

### Frontend

Vite + React 18 + Zustand v5 + React Router v6. All routes live under `/app` behind `RequireAuth` (`requireSuperuser` for `/app/admin`); `/` and `*` redirect to `/app`. State lives in five Zustand stores (`auth`, `contacts`, `schedule`, `ui`, `wa`); `api/*` wraps `apiRequest`, and `api/sse.ts` wraps `EventSource`.

Compose lives on the **Dashboard**, not on `/app/schedule` — the Schedule page is list-only and links back to `/app#compose`.

## Scheduler invariants

Read `modules/scheduler/{poller,service}.ts` together before touching either.

- **Atomic claim**: `pickDue()` runs inside `BEGIN IMMEDIATE`, selects rows where `is_active = 1 AND next_run_at <= now AND picked_at IS NULL`, stamps `picked_at = now`, commits. There is no `state` column — `picked_at` *is* the lease. Every terminal path in `service.ts` must reset `picked_at = null`.
- **Lease recovery**: a crash between claim and record would strand `picked_at` and make the row invisible to `pickDue()` forever, so `poller.start()` calls `releaseStaleLeases()` before the first tick. Single-instance means any lease present at boot is orphaned by definition — the same reasoning as `clearOrphanConnecting()` on the WA side. It logs at `warn` when it clears anything, which is your signal the last shutdown was unclean.
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
- **WA closes sockets with no statusCode.** `message === 'disconnected'` and `statusCode === undefined` is normal server-side drop, not a logout. Reconnect is exponential (`2^n`, capped 60s) up to `MAX_RECONNECT_ATTEMPTS = 5`, then `failed` with a readable error.
- **`reconnectAttempts` must reset on manual `connect()` and `disconnect()`** (and does on `'open'`) — otherwise a user who hits the cap can never recover from the UI.
- **`shutdown()` and `disconnect()` MUST set `intentionalClose = true` before `sock.end()`.** Otherwise the close handler treats it as a drop, flips the DB row to `connecting`, and the next boot shows a phantom connecting state with no socket behind it.
- **`restoreAll()` calls `clearOrphanConnecting()` first.** Any `connecting`/`qr_pending` row at boot is a lie; it is reset to `disconnected` so the UI matches reality. Only `connected` rows are restored.
- Contact sync is **opportunistic and stateless**: `contacts.upsert`/`contacts.update` fire post-pair and each is upserted immediately. There is no "sync complete" event and no done-detection — don't build UI that waits for one.
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
- The container holds a **live paired WhatsApp session**. Every deploy restarts it: sockets drop, `restoreAll()` re-handshakes from `backend/data/sessions/`, and a session that fails to restore needs a QR re-pair from the phone. This is the standing cost of auto-deploy — batch merges rather than pushing to `main` repeatedly.
- **There are no backups — none scheduled, and the deploy takes none.** Removed deliberately on 2026-08-10 at the owner's instruction; the archives and the cron are gone. `deploy/backup.sh` still exists as a manual tool if you ever want a snapshot, but nothing invokes it.
- **Rolling the image back does not roll the schema back, and there is nothing to restore from.** A destructive or non-backward-compatible migration is therefore unrecoverable — it takes the accounts, contacts, schedules, and every paired WhatsApp session with it. This raises the bar on migration review considerably; treat it as the primary risk in any schema change.
- Losing `sessions/{userId}/` costs that user a re-pair; losing `promitto.db` costs all accounts, contacts, and schedules.

## Breaks silently if you miss it

- `SESSION_SECRET` must be ≥32 chars — the zod env schema `process.exit(1)`s at boot otherwise, and there is no other validation layer. `CSRF_SECRET` has the same floor but is **optional** and falls back to `SESSION_SECRET`, so an existing deployment without it still boots.
- The service worker must **never** cache `/api/*` (`frontend/public/sw.js`) — stale scheduler state is worse than none. Shell-only: cache-first for `/assets/`, network-first for navigations.
- Empty Zustand generic arg trips the eslint empty-type rule — use the v5 curried form: `create<State>()((set) => …)`.
- Drizzle 0.36.x index API: return a plain object from the table callback, `(t) => ({ idx: index(...) })`, not an array.
- Traefik's `exposedByDefault=false` means the `web` network and the labels must both be present, or the container simply isn't routed.
- `@inquirer/prompts` needs a TTY — anything piping stdin must use the `scripts/test-*` helpers instead.
- **`backend/.env` must exist before any `docker compose` command**, including `typecheck` and `lint` — the dev compose file declares `env_file`, so compose aborts before your command runs if it's missing. `cp backend/.env.example backend/.env` first. To check types without one: `docker build -q -t promitto-backend-check -f backend/Dockerfile.dev backend && docker run --rm promitto-backend-check sh -c "npm run typecheck && npm run lint"`.
