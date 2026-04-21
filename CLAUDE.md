# Promitto — Claude notes

Self-hosted WhatsApp scheduler. One VPS, one container, SQLite, Baileys. No SaaS, no signup, admin-provisions users.

## Stack at a glance

- **Backend**: Node 20 + Express 4 + TypeScript, SQLite via Drizzle ORM, Baileys (`@whiskeysockets/baileys` 7.0.0-rc.9)
- **Frontend**: Vite + React 18 + TS + Tailwind + Zustand + React Router v6
- **Runtime**: single Docker container behind Traefik v3.2 on the shared `web` network
- **Prod domain**: `wa.muhfaza.my.id`

## Layout

```
backend/src/
  main.ts                  entry, wires server + poller + wa-manager + SIGTERM
  server.ts                Express app, CORS, /api/health, SPA fallback (prod)
  config/                  env.ts (zod-validated), constants.ts
  db/                      client.ts, schema.ts, migrate.ts  (0700/0600 perms enforced)
  middleware/auth.ts       requireAuth / requireSuperuser (reads signed session cookie)
  lib/
    cookie-signer.ts       HMAC-SHA256 signing of session IDs with SESSION_SECRET
    password.ts            Argon2id
    session-id.ts          opaque random tokens
    cron.ts, timezone.ts   cron-parser v5 + luxon
    phone.ts, jid.ts       libphonenumber-js (ID default) + JID helpers
  modules/
    auth/                  login/logout/me/reset
    users/                 superuser CRUD + disable
    contacts/              CRUD + search + sync-upsert from Baileys
    wa-sessions/manager.ts SessionManager (singleton); per-user Baileys socket + SSE bus
    scheduler/             routes + service (BEGIN IMMEDIATE claim) + poller (30s tick)
    settings/              per-user timezone
  cli/                     create-superuser.ts, reset-superuser-password.ts
  scripts/                 test-seed-* helpers (non-interactive for CI)

frontend/src/
  main.tsx, App.tsx        routes under /app, RequireAuth wrapper
  pages/
    Login                  Fraunces-masthead sign-in
    Dashboard              primary compose surface — masthead + WA card + ComposeScheduleForm + "next up" + nav rail
    WhatsApp               pairing / QR / disconnect
    Contacts, Settings, Admin
    Schedule               list-only (Upcoming / Recurring / History / Failed). Compose lives on Dashboard; this page has a "+ Compose" link back to `/app#compose`.
  components/
    ComposeScheduleForm    shared compose form (recipient + message + once/recurring + cron preview + submit)
    ContactPicker          single-select autocomplete; uses contacts.list with search
    WaStatusIndicator      WaStatusDot + WaStatusLabel (AppHeader + Dashboard)
    InstallButton, RequireAuth, ui/*
  stores/                  auth, contacts, schedule, ui, wa  (Zustand v5 curried form)
  api/                     client.ts, sse.ts + per-module wrappers
  lib/                     dates (luxon), cn, types
  public/                  manifest.webmanifest, sw.js (shell-only), icons

deploy/
  entrypoint.sh            migrate → node dist/main.js
  backup.sh                tarball backend/data to ~/promitto-backups (UTC stamp)
```

## Frontend design system

Aesthetic: **"quiet utility ledger"** — warm paper + ink, deliberate typography, hairline borders instead of cards-with-shadows. Keep it that way.

- **Palette** (`tailwind.config.js`): `paper` (cream `#F5F1E8`) / `paper-raised` / `ink` (near-black) / `ink-soft` / `ink-muted` / `rule` (warm hairline) / `accent` (olive `#5C6B3E`, "live/success") / `accent-warm` (terracotta `#A8583A`, "destructive/failed") / `amber-soft` (warnings). No `slate-*`, no `emerald-*`, no `red-*` — use the tokens.
- **Fonts** (loaded from Google Fonts in `index.html`):
  - `font-display` → **Fraunces** (variable serif, italic for H1/H2/section titles)
  - `font-sans` → **Geist** (body, labels, buttons)
  - `font-mono` → **Geist Mono** (identifiers only)
- **Mono is reserved for machine-generated data**: timestamps, JIDs, phone numbers, cron expressions, emails. **Do not use mono for prose, hints, error text, badge labels, or tab labels** — it reads like typewriter noise.
- **Headings** use Fraunces italic. Section eyebrows use the `.eyebrow` utility in `index.css` (Geist uppercase tracking-caps, sans). Do not invent new heading styles.
- **Structure**: hairline rules (`border-rule`, `<hr>`) separate sections. Cards = `.ledger-card` (border + paper-raised bg) or inline `border border-rule bg-paper-raised`. No rounded-xl / drop-shadow defaults.
- **Motion**: CSS-only (`animate-fadeInUp` for page entrances, `animate-ping` on pending WA status). Don't pull in framer-motion.

## Key constraints (don't expand scope)

- **Single instance.** Poller and `SessionManager` are process singletons. Never run replicas.
- **Text messages only.** No media, no templates, no blasts.
- **One WhatsApp number per user.**
- **No signup.** Superuser creates accounts via CLI. First superuser bootstrapped via `cli/create-superuser.ts`.
- **Superuser reset is CLI-only.** No email, no recovery link. Intentional.
- **Admin-provisioned.** Temp passwords shown once; user must rotate on first login.
- **Hard sends are warnings, not caps.** UI warns on ≥10 pending or any recurring create — no blocking.

## Auth model

- Passwords → Argon2id (`lib/password.ts`)
- Sessions → opaque random token, HttpOnly cookie, **signed** with `SESSION_SECRET` via HMAC-SHA256 (`lib/cookie-signer.ts`). Rotating `SESSION_SECRET` invalidates all sessions by design.
- CSRF tokens → HMAC-SHA256 of session id, keyed by `CSRF_SECRET` (`lib/csrf.ts`). Falls back to `SESSION_SECRET` when unset; set distinct in production to separate HMAC keyspace. Rotating invalidates outstanding CSRF cookies on next login.
- `requireAuth` middleware calls `readSignedSessionId()` → `getSessionWithUser()` → `touchSession()` → `setCsrfCookie()` (sliding TTL on both session row and CSRF cookie `maxAge`)
- Superuser gating via `requireSuperuser` (checks `req.user.role === 'superuser'`)
- Login wraps session revocation + new-session insert in a single `sqlite.transaction().immediate()` so concurrent double-submits can't leave multiple live sessions.

## Scheduler invariants

- **Atomic claim**: `BEGIN IMMEDIATE` then `UPDATE ... SET state='sending' WHERE id=? AND state='pending'` — prevents double-dispatch even with overlapping ticks.
- **Jitter**: 2–8s random delay before send to avoid burst patterns.
- **Retry backoff**: `[30s, 2m, 10m]` — 3 attempts then `failed`.
- **Tick**: 30s. Picks up to N due rows per tick.
- **Timezones**: stored per-user (IANA), evaluated with luxon; cron next-run computed in user TZ, stored as UTC ms.

## Baileys quirks worth remembering

- Use `fetchLatestWaWebVersion()` before `makeWASocket()` — hardcoded versions go stale and break the Noise handshake.
- Auth state dir = `backend/data/sessions/{userId}` with 0700/0600 perms enforced on every creds save.
- Contact sync is **opportunistic** — `contacts.upsert` and `contacts.update` fire post-pair; no "sync complete" event. Done-detection is a heuristic (debounced quiet window).
- JIDs use `@s.whatsapp.net`; group JIDs (`@g.us`) are rejected at `isUserJid()`.
- **WA can close a socket without a statusCode.** `lastDisconnect.error.message === 'disconnected'` with `statusCode === undefined` is common (server-side drop, no 401). Don't interpret this as "retry forever" — we cap at `MAX_RECONNECT_ATTEMPTS = 5`, then transition to `failed` with a readable error.
- **`reconnectAttempts` must reset on manual `connect()` and `disconnect()`** — otherwise a user hitting the cap can never recover via the UI. The 'open' handler also resets it to 0 on success.
- **`shutdown()` MUST set `h.intentionalClose = true` before `sock.end()`.** Otherwise Baileys fires `connection: 'close'` → `handleConnectionUpdate` sees `intentionalClose: false` → flips the DB row to `connecting` → on next boot, the user is stuck in a phantom connecting state with no active socket.
- **`restoreAll()` normalizes orphan rows before restoring.** Any `connecting`/`qr_pending` in DB at boot is a lie (the in-memory handle that was driving it is gone) — `clearOrphanConnecting()` resets them to `disconnected` so the UI matches reality.
- `BAILEYS_LOG_LEVEL` env var (default `silent`) lets prod surface Baileys' internal socket lifecycle at `info`/`warn` for live diagnostics without rebuilding.

## Dev (Docker)

```bash
cp backend/.env.example backend/.env       # defaults are fine for SQLite dev
docker compose up --build                  # backend:3000, frontend:5173

docker compose exec backend npm run typecheck
docker compose exec backend npm run lint
docker compose exec frontend npm run typecheck
docker compose exec frontend npm run lint

docker compose exec backend npm run db:generate   # after schema.ts edits
docker compose exec backend npm run db:migrate

docker compose exec backend npm run cli:create-superuser
docker compose exec backend npm run cli:reset-superuser-password
```

Dev note: dev compose uses a named volume for `backend/node_modules`. After changing `backend/package.json`, run `docker compose run --rm backend npm install` or rebuild — otherwise the volume masks the new deps.

## Prod (Docker)

```bash
# one-time
cp .env.production.example .env
openssl rand -base64 48                    # paste into SESSION_SECRET=

# deploy / upgrade
./deploy/backup.sh                         # always snapshot first
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f promitto | head

# first superuser (TTY required)
docker compose -f docker-compose.prod.yml exec promitto node dist/cli/create-superuser.js

# health
curl https://wa.muhfaza.my.id/api/health
```

The entrypoint runs `db:migrate` before starting the server. Migrations must be backward-compatible with the previous release in case of rollback.

## Things that break silently if you miss them

- `SESSION_SECRET` must be ≥32 chars; env schema rejects short ones at boot. `CSRF_SECRET` has the same floor but is optional (falls back to `SESSION_SECRET`).
- Tests/CLIs that pipe stdin can't use `@inquirer/prompts` (needs a TTY). Use `scripts/test-*` helpers for non-interactive flows.
- Empty Zustand generic arg trips the eslint empty-type rule — use the v5 curried form: `create<State>()((set) => (...))`.
- Drizzle 0.36.x index API: pass a plain object `(t) => ({ idx: index(...) })`, not an array.
- The service worker must **never** cache `/api/*`. Shell-only caching; everything else is network-first.
- Traefik `web` network must be attached explicitly; `exposedByDefault=false` means no labels = no routing.

## What NOT to do

- Don't introduce Redis, BullMQ, or multi-replica anything. If you outgrow one VPS, rewrite — don't retrofit.
- Don't add `/signup`, password recovery, or email flows. Breaks the threat model.
- Don't widen scope to media, templates, broadcasts, or groups.
- Don't reduce auth-state file perms (0700 dir / 0600 files). Baileys creds are as sensitive as the WA session itself.
- Don't skip `backup.sh` before an upgrade with pending migrations.
