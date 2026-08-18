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

docker compose exec backend npx tsx scripts/test-interaction-flush.ts   # recents assertions
docker compose exec backend npx tsx scripts/test-retention-sweep.ts     # retention assertions
docker compose exec backend npx tsx scripts/test-ip-anonymize.ts        # IP coarsening assertions
```

**There is no test framework.** No `test` script, no runner, no `*.test.ts` anywhere — so there is no "run a single test". Verification is `typecheck` + `lint` + exercising the app. If you add tests, you are also picking the runner; say so rather than assuming one exists.

`scripts/test-seed-superuser.ts` and `scripts/test-reset-superuser.ts` are **not** tests — they are non-interactive stand-ins for the `@inquirer/prompts` CLIs (which need a TTY), e.g. `tsx scripts/test-seed-superuser.ts <email> <password>`.

`scripts/test-interaction-flush.ts`, `scripts/test-retention-sweep.ts` and `scripts/test-ip-anonymize.ts` **are** real verification suites despite sharing that prefix. The IP one needs no database — `anonymizeIp` is pure — and is mostly rejection cases, because a fabricated prefix is indistinguishable from a real one once it is in `sessions.ip`. The retention one asserts that expired history is deleted while active and recurring schedules survive, that tenancy holds, and that dry-run deletes nothing — run it after touching `modules/privacy/retention.ts`. As for the recents one: 9 `node:assert/strict` assertions over `recordInteractions` / `recordPinStates` / `listRecent`, against a throwaway SQLite file it migrates and deletes (never the dev DB), exiting 1 on the first failure. Run it after touching recency, pin mirroring, or the recents query. It is still not a *framework* — no runner, no discovery, and nothing else is covered.

Dev-compose gotcha: `backend/node_modules` is a named volume. After changing `backend/package.json`, run `docker compose run --rm backend npm install` or rebuild — otherwise the volume masks the new deps.

## Architecture

### One process, four long-lived things

`backend/src/main.ts` starts the Express server, then boots the other three **in this order, all of it deliberate**: `sessionManager.restoreAll()` raced against `BOOT_RESTORE_TIMEOUT_MS` (30s — a slow pairing must not hold the rest of the process hostage), then `schedulerPoller.start()`, then `sessionManager.startSupervisor()` *after* the restore race because both open sockets and letting them overlap races the same handle, then `memoryMonitor.start()` last so its first window measures a settled process rather than the allocation storm of boot. Teardown runs the reverse-ish order on SIGTERM/SIGINT: monitor → poller → sessionManager → server (`server.close()` plus `closeAllConnections()`, or the never-ending SSE streams make the clean path unreachable).

`unhandledRejection` / `uncaughtException` log the cause and then run the **full graceful shutdown**, not a bare `process.exit`: Baileys still closes its sockets cleanly and pending contacts still flush. It exits **non-zero** on purpose so `restart: unless-stopped` restarts us, and `shutdown()` is re-entrancy-guarded — a second signal, or a fault raised from inside the teardown, exits rather than unwinding twice. Before these handlers existed a stray rejection killed the process with no log line at all.

`process.umask(0o077)` is the first *statement*, so every file the process creates at runtime (SQLite DB, Baileys creds) is private by default. Note it is **not** in force during module evaluation: ESM hoists all `import`s above it, so anything created at import time predates it. Nothing currently relies on that — `db/client.ts` `chmodSync`s the DB/WAL/SHM explicitly, and auth state is written well after boot — but don't add import-time file creation and assume the umask covers it.

Both the poller and the `SessionManager` are **module-level singletons holding in-memory state** (open sockets, tick locks). This is why replicas are forbidden — two processes would double-send and fight over the same WA sockets.

### Request path

`server.ts` → `requestLogger` → `express.json({limit:'1mb'})` → `cookieParser` → `/api/health` → six routers → `errorMiddleware`. No CORS middleware: dev goes through Vite's `/api` proxy (`VITE_PROXY_TARGET`), prod is same-origin because the same Express process serves `frontend/dist` with an SPA fallback for any non-`/api` GET.

`/api/health` returns `{status, db, sessions, wa: {expected, connected, lastCheckAt}, mem: {rssMb, heapUsedMb, heapUsedPct}}`. **`wa` and `mem` are conditionally spread** — if the call behind either throws, the key is omitted entirely, never sent as `null`. `mem` is a point-in-time read of the same numbers the 5-minute telemetry line carries, so heap pressure can be checked without shelling into the box. `wa.lastCheckAt` is the last supervisor tick (epoch ms, `null` before the first): an idle tick logs nothing, so without it a wedged supervisor looks exactly like a healthy one. Stale by more than ~60s means nothing is watching the sessions any more. **`status` is driven by the DB ping alone, deliberately** — `deploy.yml` greps for `"status":"ok"` to decide whether to roll back, and a fresh container legitimately takes ~13s to restore its WhatsApp sessions, so a WA-aware `status` would roll back every deploy. `wa.expected` vs `wa.connected` is the signal instead: divergence means the container is up and serving while WhatsApp is dead, which went unnoticed for 1h15m in Aug 2026. The endpoint must never throw — a 500 here trips the rollback.

Routers and their gating (`A` = `requireAuth`, `P` = `requirePasswordRotated`, `C` = `requireCsrf`, applied via `router.use(...)`):

| Mount | Gate | Notes |
|---|---|---|
| `/api/auth` | none (`/me` uses `A`) | `login`, `logout`, `me` — both POSTs are deliberately CSRF-exempt |
| `/api/users` | `A` + `P` + `C` + `requireSuperuser` | list/create/disable/enable/reset-password/delete |
| `/api/wa` | `A` + `P` + `C` | `connect`, `disconnect`, `logout`, `status`, `events` (SSE) |
| `/api/contacts` | `A` + `P` + `C` | list (search, limit capped 200), `recent` (WA-pinned first, then interaction recency, limit capped 50), create, rename, `GET /:id/avatar` (302 to the WA CDN, or 404), `POST /purge-synced` (registered above `/:id` so the literal path wins), delete |
| `/api/scheduler` | `A` + `P` + `C` | create, list (`?status=upcoming\|recurring\|history\|failed`), `stats`, `preview`, patch, cancel |
| `/api/settings` | `A` + `C`, `P` per-route | password, timezone, timezone list (`GET /timezones` un-gated by `P` on purpose), `retention`, `contact-sync`, `purge-data`, `DELETE /account` |

Every module follows `routes.ts` (zod parsing + HTTP) → `service.ts` (Drizzle, synchronous better-sqlite3). Services take `userId` as the first argument and scope every query by it — that per-query `userId` filter *is* the tenancy boundary; there is no row-level security underneath it.

### Wire conventions

- **Errors**: throw `errors.*()` from `lib/errors.ts`; `errorMiddleware` renders `{ error: { code, message, details? } }`. Bare `ZodError` is auto-converted to a 400 `validation_error`. The frontend's `apiRequest` unwraps that envelope into an `ApiError`.
- **Timestamps**: SQLite stores `timestamp_ms` integers; serializers (`lib/scheduled-message.ts`, `lib/contact.ts`, `lib/user.ts`) emit **epoch-ms numbers**, never ISO strings. The frontend formats with luxon in the user's TZ.
- **Never return a raw DB row** — go through the serializer, or you leak `passwordHash`, `pickedAt`, and friends.

### Data model (`backend/src/db/schema.ts`)

`users` → `sessions`, `wa_connections` (PK is `user_id`, so one WA number per user by construction), `contacts` (unique on `user_id + jid`), `scheduled_messages`, `sent_messages`. All child tables cascade on user delete. Migrations are Drizzle SQL files in `backend/drizzle/`; the prod entrypoint applies them before the server boots, so **every migration must be backward-compatible with the previous release** in case of rollback.

`sent_messages` is an append-only attempt log, one row per send attempt (success *and* failure) — it is not a mirror of `scheduled_messages`. "History" and "Failed" in the UI are both reads of this table.

`contacts.last_interaction_at` and `contacts.wa_pinned_at` are both nullable. `listRecent()` orders WA-pinned rows first (`wa_pinned_at DESC` — newest pin first, matching WhatsApp), then the rest by `COALESCE(last_interaction_at, newest scheduled_messages.created_at per recipient) DESC`; rows with none of the three signals are excluded, and a WA-pinned row always appears. The fallback subquery is scoped by `userId` on both sides — that filter is the tenancy boundary, and `scripts/test-interaction-flush.ts` asserts it.

**That ordering is not index-backed and don't assume it is.** `contacts_user_recent_idx` covers `(user_id, last_interaction_at)`, but the query's leading sort keys are `wa_pinned_at IS NULL`, `wa_pinned_at DESC`, and then a `COALESCE` over a grouped `scheduled_messages` subquery — SQLite sorts the result set for all three. At a per-user contact list of this size that is free; it stops being free at a scale this app is explicitly not built for.

`wa_pinned_at` is a **read-only mirror of WhatsApp's own chat pin**, never an app-local concept — an app pin that didn't correspond to a real WhatsApp pin would read as a bug. Nothing in the API writes it; only `recordPinStates()` does, from WA chat events. It is **latest-wins, not monotonic** (unlike `recordInteractions()`, which is both UPDATE-only and monotonic): an unpin is a `null` that must overwrite a timestamp, and a re-pin carrying an older stamp is still the current state. Don't "fix" it to match `recordInteractions()`. Caveat on an already-paired session: WhatsApp's app-state sync delivers pin *changes*, not the historical set, so pins that existed before this feature shipped only appear after an unpin→re-pin on the phone.

### Frontend

Vite + React 18 + Zustand v5 + React Router v6. All routes live under `/app` behind `RequireAuth` (`requireSuperuser` for `/app/admin`); `/` and `*` redirect to `/app`. State lives in five Zustand stores (`auth`, `contacts`, `schedule`, `ui`, `wa`); `api/*` wraps `apiRequest`, and `api/sse.ts` wraps `EventSource`.

Compose lives on the **Dashboard**, not on `/app/schedule` — the Schedule page is list-only and links back to `/app#compose`.

`stores/contacts.ts` owns the **recents list only** — not the contact list, which stays local to the pages that fetch it. It pages 6 at a time (`RECENT_PAGE`) up to `RECENT_MAX = 48` via "Show more ↓"; each press refetches `/contacts/recent` at the larger limit rather than appending, and `limit` persists in the store so a refetch after a send keeps an expanded list expanded (`reset()` puts it back to 6). **`hasMore` is a heuristic**: the endpoint returns rows and no total, so a full page is the only "more exist" signal there is — it can be one press late, and that is accepted. Both `load()` and `showMore()` swallow their errors on purpose: the quick-pick is an accelerator, not a control, so a failed fetch hides it and leaves the picker to do the work. No toast.

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
- **rc14 is patched.** `backend/patches/@whiskeysockets+baileys+7.0.0-rc14.patch` hoists the signal-key transaction `AsyncLocalStorage` in `lib/Utils/auth-utils.js` to module scope. rc14 creates one **per `makeWASocket()` and never disables it**, so every socket *and every reconnect* leaks a live instance, and under Node's legacy async-context propagation each one tags every pending async resource. Upstream PR #2666 / #2722 fix it identically; neither had landed when rc14 shipped on 2026-07-29. This is a growth term that scales with users — it matters when you add people, not at one.
  - The shared ALS stores a **Map keyed by a per-store `Symbol`**, and that keying is load-bearing. Hoisting it naively — the obvious fix — makes store B running inside store A's transaction see A's context and commit **B's key writes into A's backing store**. With one paired user you would never notice; with several it is silent cross-account Signal key corruption. `npm run test:signal-tx` asserts exactly that case and **fails on the naive hoist** (verified, not assumed).
  - `patch-package` with no `patches/` directory prints "No patch files found" and **exits 0**. That is why the Dockerfile copies `backend/patches` *before* `npm ci` and then greps the built image for `signalTxStore` — otherwise a reordered COPY silently ships the leak back. Re-run `npm run test:signal-tx` after any Baileys bump; the patch will stop applying, and that is your signal.
- Call `fetchLatestWaWebVersion()` before `makeWASocket()` (cached process-wide) — hardcoded versions go stale and break the Noise handshake.
- Auth state = `backend/data/sessions/{userId}`, **0700 dir / 0600 files**, re-chmod'd on every `creds.update`. Don't loosen this; Baileys creds are as sensitive as the WA session itself.
- **WA closes sockets with no statusCode.** `message === 'disconnected'` and `statusCode === undefined` is normal server-side drop, not a logout. (rc14 now wraps most of its own closes in Boom — `connectionClosed` 428 and `connectionLost` 408 — so a bare `undefined` is rarer than it used to be. Only 401 is branched on, so this doesn't change behaviour.)
- **Two-tier reconnect.** Fast ladder in the close handler: `2^n` capped 60s, `MAX_RECONNECT_ATTEMPTS = 7` → 1,2,4,8,16,32,60s ≈ 123s. Exhausting it writes `failed` but is **not terminal** — the supervisor takes over. Every close and every scheduled attempt logs; before this existed a drop logged nothing at all, which is why the Aug 2026 incident could not be reconstructed.
- **The supervisor is the backstop.** `startSupervisor()` runs a `reconcile()` every 60s comparing DB intent (`listRestorable()`) against live sockets, and reopens anything stranded — backoff 60s→15min with jitter, and it never permanently gives up. It exists because *any* missed path (a timer lost to a process death, an unhandled close) used to strand a session until a human pressed Connect. Warns once a session is down >5min, re-warning every 15min.
  - `reconcileBackoffMs()` returns a **floor, not a schedule.** `nextReconcileAt` is only ever tested by the 60s tick, so every delay rounds up to the next tick boundary and the ≤20% jitter pushes it past the boundary it would otherwise have landed on. Real spacing is ~120s, 180s, 300s, 600s, then ~16–18min — about one tick slower than 60/120/240/… reads. That is the intent; don't "fix" it by dropping the jitter or aligning the constants.
- **Two statusCodes are special-cased.** `restartRequired` (515) is a routine post-pair instruction, so it reconnects on a 1s floor without spending a ladder rung — budget capped at 3 and only refilled once a connection has held `STABLE_CONNECTION_MS`, or an open→515 flap loops forever. `connectionReplaced` (440) means another WhatsApp Web login took over: it stops dead at `disconnected` (deliberately not supervisor-eligible) because retrying fights the other session and repeated conflicts can get the number flagged.
- **A socket only counts while it owns the handle.** `handleConnectionUpdate` takes the socket it was registered for and ignores events from any socket that is no longer `h.sock` (or is in `h.abandonedSocks`). Without that guard a dying socket's close nulls `h.sock` out from under the *live* one — and a stale 401 reaches `wipeAuthState()` and revokes credentials the live socket is still using.
- **`reconnectAttempts` must reset on manual `connect()` and `disconnect()`** (and does on `'open'`) — otherwise a user who hits the cap can never recover from the UI.
- **`shutdown()` and `disconnect()` MUST set `intentionalClose = true` before `sock.end()`.** Otherwise the close handler treats it as a drop, flips the DB row to `connecting`, and the next boot shows a phantom connecting state with no socket behind it.
- **`restoreAll()` restores `connected` + `connecting` + `failed`** (`RESTORABLE_STATUSES` in `wa-sessions/service.ts` — one definition, also used by the supervisor and `/api/health`). All three mean "credentials on disk are valid and the owner's intent is to be connected". It calls `resetOrphanQrPending()` first, which resets **only** `qr_pending` — a QR nobody is watching is genuinely dead. `disconnected` is an explicit user choice and `logged_out` had its auth dir revoked, so neither is restored.
  - This is the fix for the Aug 2026 incident: a heap-OOM death lands the row on `connecting` (GC thrash starves the keepalive, so the socket drops seconds *before* the process dies), and the old `clearOrphanConnecting()` rewrote that to `disconnected` and then restored only `connected` — so the session was unrecoverable by construction. WhatsApp was down 1h15m behind a green health check.
  - `connecting` rows keep their `lastError` on purpose. Blanking it destroyed the only record of why the socket dropped.
  - Restore and the supervisor both check `creds.json` exists first (ENOENT only — a transient EACCES/EIO must not de-register a session), so a credential-less row can't spend a pairing attempt emitting a QR nobody scans.
- Contact sync is **opportunistic and stateless**: `contacts.upsert`/`contacts.update` fire post-pair and each is upserted immediately. There is no "sync complete" event and no done-detection — don't build UI that waits for one.
- Interaction recency is captured the same way: `messaging-history.set` / `chats.upsert` / `chats.update` / `messages.upsert` feed a per-user `(jid, epoch-ms)` buffer (same debounce + hard cap as contact sync) flushed via UPDATE-only `recordInteractions()`. Handlers are synchronous extraction only — never retain chat/message objects (old-space is capped at 192 MB). Baileys timestamps arrive in **seconds** as `number|Long|null`; `waTsToMs()` normalizes. WhatsApp replays chat history only at pair time, so on an already-paired session this data accrues from live traffic — the scheduling-history fallback in `listRecent()` covers the gap.
- **Chat and message events may be LID-addressed** (`<n>@lid`) on a LID-migrated account, so every jid on this path is normalized to its phone form *before* the `isUserJid()` gate — synchronously from `key.remoteJidAlt` (messages) or `pnJid` (chats) where present, otherwise by queueing the primitives for `signalRepository.lidMapping.getPNsForLIDs()` and replaying the translated jid into the same buffers. **`remoteJidAlt` is trusted only when `!key.fromMe`**: it is the PN twin of the *sender*, not of the chat, so on a fromMe message synced from the phone it is the user's own number while `remoteJid` is the counterpart's LID — trusting it there mis-files the interaction under the user's own contact. `getPNsForLIDs` answers with a `:<device>` suffix, so results go through `jidNormalizedUser` or they fail the gate for the same reason the lid did. Gating first, as the original code did, silently dropped every `@lid` event — and since the pin sync emits a bare `{id, pinned, conditional}` with no phone form, that meant **no pin ever reached `wa_pinned_at`** on a migrated account. The queue is one FIFO drained by a single non-reentrant loop because `pendingPins` is latest-wins: resolving concurrently could replay a pin after the unpin that followed it. For the same reason an already-resolved **pin** is queued too (flagged `resolved`) whenever the queue is live — inline it would not be ordered against the queued entries at all. Interactions stay inline; a high-water mark is immune to reordering. No local lid→pn cache — `LIDMappingStore` already fronts the auth state with an LRU and coalesces lookups.
  - The queue is bounded by `LID_QUEUE_MAX = 2_000` as a heap backstop, not as a policy: past the cap entries are dropped and the *episode* logs one `debug` line (`lidOverflowed` latches until the queue drains), so a history replay can't turn the log into the leak. The drain also **discards its whole batch** when `!h.sock`, `h.tearingDown`, or `this.stopped` — checked before *and* after the `getPNsForLIDs` await, because `disconnect()` sets `tearingDown = true` before `sock.end()` but only nulls `h.sock` after it, and for the length of that await the socket check alone would let a late batch arm a debounce timer behind the final flush.
- The three **chat-shaped** events above (not `messages.upsert`, which carries no pin info) also mirror WhatsApp's pin state into `wa_pinned_at` via a second per-handle buffer, `pendingPins`, flushed alongside the interaction buffer by `flushPendingRecency()`. The field is read by key presence, never truthiness: **absent means "this event says nothing about pinning"** and must not touch the row, while a present-but-falsy value is a real unpin. **It must be `Object.prototype.hasOwnProperty.call(c, 'pinned')`, not `'pinned' in c`** — decoded `proto.Conversation` instances (history sync, and the buffered `chats.upsert`) inherit `pinned = null` from their prototype, so `in` is true for every chat in a history replay and would mass-unpin the contact list; real pins are always own properties. Inbound, `pinned` is only ever `number|null` seconds — rc14's boolean pin site (`Utils/chat-utils.js:491`) builds an *outbound* patch and is never emitted back, so `pinToMs()`'s boolean branch is defensive, not a live path. The buffer is latest-wins, not max; see the data-model section. Logout deliberately leaves `wa_pinned_at` in place (unlike `avatarCache`, which is cleared): it is a last-known mirror still worth using for ordering, exactly like `last_interaction_at`, and a re-pair's history sync refreshes it. Pin events are the ones that **need** the LID translation above: `chat-utils.js:737-744` emits `{id, pinned, conditional}` and nothing else, so a LID-addressed chat arrives with no phone form attached and only the mapping store can attribute it.
- `getAvatarUrl()` resolves a contact's profile picture to a WA CDN URL (`profilePictureUrl(jid, 'preview', 5000)`) for the route to 302 to — the image is never proxied. Results are cached **per handle**, 6h for a hit and 10min for a miss; a miss covers a disconnected session and a privacy-hidden picture alike, and caching it is what stops every dashboard render from re-round-tripping a whole list. Errors resolve to null, never throw. The 5000 only bounds Baileys' IQ round trip — the pre-query awaits (tc-token, LID resolution) are unbounded — so the whole call is additionally raced against a 7s timeout that resolves null and caches the miss. The cache is capped at 1000 entries (cleared wholesale on overflow; contact counts make this a backstop, not a policy) and is cleared with the credentials on logout, since a new pairing may see different pictures. The route only 302s to a parseable `https:` URL; anything else takes the same 404 path as null.
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
- **Fonts** are **self-hosted and subset** — `@font-face` blocks at the top of `index.css`, `.woff2` files in `src/assets/fonts/`. `font-display` → Fraunces, `font-sans` → Geist, `font-mono` → Geist Mono. Imported from `src/` (not `public/`) on purpose, so Vite fingerprints them into `dist/assets/` where they inherit the immutable 1-year cache header.
  - **Fraunces ships the ITALIC face only.** The roman face was 67KB of woff2 serving a single heading, and every display element in the app was already italic, so it was dropped and the last upright heading (`Dashboard.tsx`) was italicised. Anything using `font-display` must be explicitly `italic` — leave it off and it still renders italic (font matching finds the only face), just by accident. Adding a roman heading means re-adding a 67KB file; don't do it casually.
  - Optical size is baked into the subset. The old `font-variation-settings: 'opsz' 120, 'SOFT' 50` on `h1` is gone — `SOFT` was never in the requested axes and had been silently doing nothing for as long as it existed.
  - **Never add a `<link>` back to `fonts.googleapis.com`.** That stylesheet is render-blocking on a third-party origin: DNS + TLS + request before first paint, measured by Lighthouse at ~900ms, and it pulled 201KB of woff2 against the current 61KB.
- **Mono is reserved for machine-generated data**: timestamps, JIDs, phone numbers, cron expressions, emails. Never for prose, hints, error text, badge labels, or tab labels.
- **Structure**: hairline rules (`border-rule`, `<hr>`) separate sections. Cards use `.ledger-card`; eyebrows use `.eyebrow` (both in `index.css`). No rounded-xl or drop-shadow defaults.
- **Motion**: CSS-only (`animate-fadeInUp`, `animate-ping` on pending WA status). Don't add framer-motion.
- **Icons are inlined SVG paths, not a package.** The recents pin marker is one Material Symbols `push_pin` path in `ContactQuickPick.tsx`, drawn upright and rotated `-45deg` at the call site (upright it reads as a generic marker; the tilt is what makes it WhatsApp's pinned-chat glyph). It is `text-ink-muted`, deliberately **not** `accent` — a mirrored pin is a neutral marker, not a status. Adding an icon dependency for the next glyph is a decision, not a default.
- **Avatars render initials *behind* the photo**, never as an on-error swap: the `<img>` is absolutely positioned over the initials and hides itself via `onError`, so a slow or missing picture degrades to initials with no broken-image glyph flash. `/api/contacts/:id/avatar` 404s identically for no photo, a privacy-blocked photo, and a disconnected session — all silent.

## Privacy & retention

The operator has root on the box and the scheduler must hold plaintext to send while the user
is offline, so **no app-level change hides message content from the operator** — don't add one
and don't let the UI imply otherwise. What this layer does instead is bound how much data
exists, for how long, and make all of it user-deletable. `/privacy` (public, registered before
the `*` catch-all and outside `RequireAuth`) states this plainly; keep it accurate if you
change what is stored.

- **Two `users` columns drive it**: `retention_days` (default 60; allowed 7/30/60/90/180, and
  there is deliberately **no unlimited option**) and `contact_sync_enabled` (default true —
  grandfathered ON, so this is honestly opt-*out*, not opt-in).
- **`modules/privacy/retention.ts`** sweeps every 6h plus once at boot, following the poller's
  singleton/re-entrancy idiom. It deletes `sent_messages` older than the cutoff and
  `scheduled_messages` where **`is_active = 0 AND schedule_type = 'once'`** older than the
  cutoff. Active rows and *every* recurring row survive regardless of age — a recurring
  schedule is live configuration, not history. **That predicate is the most dangerous line in
  the app**: widen it and you silently delete users' live schedules, and there are no backups.
  `scripts/test-retention-sweep.ts` asserts it; run it after touching retention.
- **`sweepUser` validates `retentionDays` itself** — non-negative integer or it throws. The
  column has no CHECK constraint, and a negative or `NaN` value future-dates the cutoff, which
  reads as "everything has expired". `0` stays legal: it *is* the user-initiated purge. The
  periodic sweeper additionally **skips** any user whose stored value isn't 7/30/60/90/180,
  logging a warning — unattended and destructive is not the place to guess.
- **Hard delete, not redaction.** A row kept with its text nulled still records who was
  messaged and when, which is the thing retention exists to stop keeping.
- **`RETENTION_DRY_RUN`** makes the periodic sweep count and log without deleting.
  **The first production deploy of this feature runs with `RETENTION_DRY_RUN=true` in
  `~/promitto/.env`** and is armed later by removing that line. The 60-day default is
  retroactive and the boot sweep fires immediately, so without this window every user
  loses history older than 60 days before they can choose 90 or 180 — and there are no
  backups. `docker-compose.prod.yml` passes it through as `${RETENTION_DRY_RUN:-false}`,
  so the safe state is opt-in and forgetting the .env line arms it rather than disabling it.
  `sweepUser(id, days, { dryRun: false })` overrides it, and the user-initiated purge pins it
  false on purpose — an operator flag must never turn "delete my data" into a silent no-op
  that still reports counts.
- **Contact syncing is gated at three write sites** in `manager.ts`, not one: the
  `recordInteractions` and `recordPinStates` flushes (one `isContactSyncEnabled` read per
  flush, so the two can't disagree mid-drain) and the `upsertSynced` flush. In all three the
  **buffer is drained before the gate is checked** — Baileys keeps streaming regardless of our
  setting, so an early return *or a throw* above the clear grows the buffer for the life of the
  process. In `flushPendingRecency` that means both buffers are copied and cleared before the
  `isContactSyncEnabled` read, which is itself wrapped: a failed read drops that batch rather
  than stranding it.
  Incoming `messages.upsert` feeds recency through the same flush, so it needs no fourth gate.
- **`purgeSynced` also nulls `last_interaction_at` and `wa_pinned_at` on the remaining manual
  contacts.** Deleting only `source = 'synced'` rows would leave a record of who the user talks
  to and when, after they asked for it to be gone.
- **Account deletion is user-reachable and unrecoverable**: password + typed `DELETE`, refused
  with 409 for the last superuser, then a best-effort `disconnect(userId, { logout: true })` to
  unlink the device from the phone (failure logs and continues — WhatsApp must never block the
  delete), the cascade, and `sessionManager.purgeAuthState(userId)`.
  - The last-superuser check is enforced **inside** `users/service.ts`'s `deleteSelf`, which
    re-reads the role and re-counts within one `sqlite.transaction().immediate()`. The route's
    own check is a cheap early exit only: it is separated from the delete by an awaited
    WhatsApp logout, so two concurrent self-deletes could otherwise both pass it and leave the
    instance with nobody who can manage users.
  - **`purgeAuthState` removes `sessions/{userId}` *and* every `{userId}.revoked-*` sibling**,
    matched by plain string comparison on the directory listing (never a regex built from an
    id). Deletion is the only path that erases credentials: `wipeAuthState` deliberately
    *renames* rather than deletes, because the 401 that triggers it is not always trustworthy
    and there are no backups — so those copies accumulate, and nothing else prunes them. Don't
    "fix" `wipeAuthState` into an `rm`; the pruning belongs where the user explicitly asked for
    everything to be gone.
- **Stored IPs are coarsened** to `/24` (v4) or `/48` (v6) by `lib/ip.ts` before they reach
  `sessions.ip`. The login rate limiter still buckets on the full `req.ip` — it is in-memory
  and never persisted. Parsing is strict and every failure returns `null`: octets must be 1-3
  ASCII digits ≤255 (`Number()` would accept `0x10` and `+1`), only one `::` is legal, zone ids
  and bracketed/port forms are handled explicitly. A `null` is safe to store; an invented
  prefix looks exactly like a real network. `scripts/test-ip-anonymize.ts` asserts it.

## Scope — do not expand

- **Single instance.** Never run replicas. If you outgrow one VPS, rewrite (Redis + BullMQ + leader election) — don't retrofit.
- **Text messages only.** No media, templates, broadcasts, or groups.
- **One WhatsApp number per user**, enforced by the `wa_connections` primary key.
- **No signup, no password recovery, no email flows.** Superuser-provisioned only; temp passwords are shown once. Superuser reset is CLI-only, deliberately.
- **Hard sends are warnings, not caps.** The UI warns at ≥10 pending or on any recurring create — it never blocks.

## Production

Single container behind Traefik v3.2 on the shared external `web` network, TLS via the `le` certresolver, HSTS middleware, `TRUST_PROXY=true`. The image builds the frontend and backend in separate stages and runs as `node`; the entrypoint runs `db:migrate` then `node dist/main.js`. Everything stateful is the `./backend/data` bind mount: `promitto.db` (WAL) plus every user's Baileys auth state.

**Responses are gzipped in Express, and must never be brotli'd.** `compression` sits high in `createApp()` — above `express.json`, both `express.static` mounts and every router, because it works by wrapping `res.write`/`res.end` and anything registered earlier escapes it. It covers the API deliberately, not just static: `/assets` is `immutable`, so after a first visit the only bytes still moving are `/api/scheduler` and `/api/contacts` JSON.
- `compression@1.8` **prefers brotli whenever the client offers it**, which is wrong here twice over — measured on the real bundle, brotli at its default quality (4) emitted 103,333 bytes against gzip's 102,674 (*larger*), while allocating a multi-megabyte window per concurrent stream. Those buffers live **outside the V8 heap**, so `NODE_OPTIONS` does not bound them and they land straight against `mem_limit: 384m`. Don't "upgrade" it.
  - `preferGzip` in `server.ts` enforces that by **replacing** `Accept-Encoding` with the single encoding we intend to send, not by deleting the `br` token from it. Subtracting the token looks equivalent and isn't: `*`, `BR, gzip` and `*;q=1, br;q=0` all still selected brotli, and the last is the dangerous one — the client had explicitly *forbidden* brotli and token-removal deleted the prohibition. Decide what we will send; don't try to subtract what the client may not have sent.
  - `shouldCompress` skips **206 / `Content-Range`** responses. `express.static` advertises `Accept-Ranges: bytes`, and compressing a byte-slice leaves `Content-Range` describing raw offsets the payload no longer has.
- The SSE stream survives this only because `/api/wa/events` sets `Cache-Control: no-transform`, which `compression` honours by skipping the response. Remove that header and WhatsApp pairing hangs with no QR and no error.
- The deploy gate is unaffected: `deploy.yml` probes `/api/health` with plain `curl` (no `Accept-Encoding`), and the response is under the 1024-byte threshold anyway.

**Security headers** are set in `middleware/security-headers.ts` (CSP, COOP, XFO, nosniff, Referrer-Policy) — HSTS stays on Traefik where TLS terminates. `script-src` is `'self'` with no nonce because the Vite build emits no inline `<script>`; `style-src` needs `'unsafe-inline'` for React's inline `style` props. **`img-src` is deliberately loose (`https:`)** — `GET /api/contacts/:id/avatar` 302s to whatever host Baileys returns for a profile picture, so pinning an origin would make avatars vanish silently the day WhatsApp moves them.

**Deploys are automated.** Pushing to `main` (anything but Markdown) runs `.github/workflows/deploy.yml`: build on the runner → rotate `promitto:deploy` to `promitto:previous` → `docker save | gzip | ssh 'docker load'` → scp the compose file → `up -d` → poll `/api/health`, rolling back to `promitto:previous` if it never goes green. `workflow_dispatch` deploys the current `main` on demand.

Deployed at `~/promitto` on the personal VPS. **Read `../CLAUDE.md` (and `~/CLAUDE.md` on the server) before touching the deployment** — that is where host-level rules live; don't duplicate them here. Promitto-specific points:

- **`docker-compose.prod.yml` has no `build:` key on purpose.** The box has ~960MB RAM and Node builds have been OOM-killed on it. `up -d --build` will fail, and that is the guard working — build elsewhere for `linux/amd64` and ship the image in. `mem_limit: 384m` matches how every other service on the box is capped.
- The container holds a **live paired WhatsApp session**, and every deploy restarts it — but that does **not** normally cost a re-pair. The pairing lives in `backend/data/sessions/{userId}/` on the bind mount and outlives the container; only the socket is disposable. Measured 2026-08-11 on a real `up -d --force-recreate`: `SIGTERM` → `Closed cleanly.` in 389ms (40s `stop_grace_period`, unused), then `wa session restored` **13.3s** after the new container started. So the true cost is ~13s of WhatsApp downtime with no phone interaction. Batching merges is still sensible, just not urgent.
  - This works because `shutdown()` deliberately **does not write status** — the row stays `connected`, which is one of the `RESTORABLE_STATUSES` the next boot restores. Do not "tidy up" `shutdown()` by having it mark rows disconnected: `disconnected` is read as a deliberate user choice and is *not* restorable, so that silently breaks QR-free restore, and nothing will fail until the next deploy.
  - A QR re-pair is only needed when the restore *fails*. Real causes: a 401 `loggedOut`, corrupt or partial auth writes, unlinking the device from the phone, or two sockets sharing one set of creds.
  - **`wipeAuthState()` renames, it does not delete.** A 401 moves the auth dir to `<dir>.revoked-<timestamp>` rather than `rm -rf`ing it. Given there are no backups, a spurious 401 used to mean permanent, unrecoverable credential loss; now the directory can be renamed back. Nothing prunes those — they accumulate, deliberately. Delete one only when you're sure the session is genuinely gone.
  - `useMultiFileAuthState` writes creds with a plain `writeFile` — no temp file, no atomic rename — so a SIGKILL mid-write can truncate `creds.json` and cost a re-pair. That is why the process is tuned to stay inside the cgroup rather than get OOM-killed (see `NODE_OPTIONS` below).
  - ⚠️ **That last cause is why blue-green / zero-downtime deploys are not an option here** — they would cause the very failure they're meant to avoid. Overlapping containers would share the Baileys creds (WhatsApp treats concurrent use as a conflict and can invalidate the session) and both would run the scheduler poller, double-sending every due message. Accept the ~13s. The only real fix is splitting the session holder into its own long-lived container, which is a rewrite and out of scope — see "Scope — do not expand".
- **Log rotation is a per-service compose key (`json-file`, `max-size: 10m`, `max-file: "5"`), deliberately not `/etc/docker/daemon.json`.** A daemon-level default needs the Docker daemon restarted, which bounces *every* container on the box — the live paired WhatsApp session and Traefik included. The compose key costs one promitto restart, on our schedule. Before this there was no rotation anywhere and container logs grew unbounded; 50MB is months of history at 288 telemetry lines/day. Any new service on this box needs its own `logging:` block — there is still no host default.
- **There are no backups — none scheduled, and the deploy takes none.** Removed deliberately on 2026-08-10 at the owner's instruction; the archives and the cron are gone. `deploy/backup.sh` still exists as a manual tool if you ever want a snapshot, but nothing invokes it.
- **Rolling the image back does not roll the schema back, and there is nothing to restore from.** A destructive or non-backward-compatible migration is therefore unrecoverable — it takes the accounts, contacts, schedules, and every paired WhatsApp session with it. This raises the bar on migration review considerably; treat it as the primary risk in any schema change.
- Losing `sessions/{userId}/` costs that user a re-pair; losing `promitto.db` costs all accounts, contacts, and schedules.

### Memory — the Aug 2026 heap deaths

The process died of `FATAL ERROR: Reached heap limit` every ~72h. Diagnosis, so nobody re-derives it:

- **V8 sizes its heap from *host* RAM, not the cgroup.** On this 965MB box it picked ~259MB — *below* `mem_limit: 384m`, so Node self-aborted before Docker's limit ever applied and `docker inspect` reported `OOMKilled: false`. The memory problem was invisible from outside the container. `--max-old-space-size=192` (the first of three flags in `NODE_OPTIONS` — see below) now pins it: deterministic, and low enough that native allocations (Node baseline, new-space, better-sqlite3, the `whatsapp-rust-bridge` WASM linear memory) stay inside 384m. Raise it and `mem_limit` together, never alone.
- **The actual churn was `chmodAuthState()`**, which walked the *entire* auth dir on every `creds.update` — ~10k files in production, measured at 801ms and +18.5MB per run, ~6 runs/hour. It's now once per directory per process (`sweptAuthDirs`), with only `creds.json` re-chmodded per save. The memory was always reclaimed, so this was allocation churn and old-space fragmentation rather than a classic retention leak.
- Ruled out with evidence: the SSE endpoint tears down both its listener and its ping interval on `req`/`res` close (and no `MaxListenersExceededWarning` ever appeared), rate-limit buckets evict, the contact buffer is capped at 200. Known upstream Baileys leaks in the rc line don't apply — the app is text-only, and while it now does subscribe to `messages.upsert` (recency capture, added with recent contacts), the handler is synchronous extraction only and retains nothing but a jid and an epoch-ms number.
- Still unproven: whether a slow ~2.7MB/h retention leak also exists — but the instrumentation to settle it **is already armed**, so the next crash answers it. `NODE_OPTIONS` in `docker-compose.prod.yml` carries three flags, not one: `--max-old-space-size=192 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/app/backend/data`. V8 dumps a full heap the instant before it aborts, and `--diagnostic-dir` is what makes the file survive the container — the default is CWD (`/app/backend`), which dies with it. **This matters much less now** — a crash no longer strands the session, because boot restore and the supervisor recover it automatically.
  - ⚠️ The snapshot lands on the **bind mount** and is up to ~195MB. `=1` is per *process* lifetime, so `restart: unless-stopped` means a crash loop writes one per restart; nothing prunes them, and nothing warns. It is written 0600 and contains everything in memory — message text, session cookies, Baileys keys. **Treat it like the DB, not like a log**: analyse it, then delete it, and never let one into a backup tarball or a paste.
- Telemetry is the other half: `lib/memory-monitor.ts` logs one `info` line every 5 minutes (288/day, sized to fit the rotation above) carrying `rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `arrayBuffersMb`, `heapSizeLimitMb`, `mallocedMb`, `peakMallocedMb`, `detachedContexts`, `heapUsedPct`, `gcPct`, `gcMajorPct`, `gcCount`, `gcMajorCount`, `waSessions`, `uptimeSec`, `windowSec`. `detachedContexts` climbing monotonically is the retention tell; `gcPct` is the fraction of *that window* spent in GC (counters zero every tick — a since-boot average flatlines and would have shown nothing over 72h). Warnings are **armed once per metric and re-armed only on recovery**, so a sustained bad state is one line, not one every 5 minutes: `heapUsedPct > 0.85` immediately, `gcPct > 0.25` on two consecutive ticks. There is no immediate first tick (a millisecond-long window has a meaningless `gcPct`), the interval is `unref()`'d so observability can never be why the process won't exit, and the WA session count is passed in as a **getter** — `lib/` never imports `modules/`, and importing `sessionManager` here would put a cycle one careless import away.
- `lid-mapping-*` and `migratedSessionCache` in Baileys rc14 are TTL-only with no entry cap, and the TTL is 72h. Suggestive given the 72h30m crash, but single-digit MB — a coincidence worth remembering, not a proven cause.

## Breaks silently if you miss it

- `SESSION_SECRET` must be ≥32 chars — the zod env schema `process.exit(1)`s at boot otherwise, and there is no other validation layer. `CSRF_SECRET` has the same floor but is **optional** and falls back to `SESSION_SECRET`, so an existing deployment without it still boots.
- The service worker must **never** cache `/api/*` (`frontend/public/sw.js`) — stale scheduler state is worse than none. Shell-only: cache-first for `/assets/`, network-first for navigations.
- Empty Zustand generic arg trips the eslint empty-type rule — use the v5 curried form: `create<State>()((set) => …)`.
- Drizzle 0.36.x index API: return a plain object from the table callback, `(t) => ({ idx: index(...) })`, not an array.
- Traefik's `exposedByDefault=false` means the `web` network and the labels must both be present, or the container simply isn't routed.
- **`stop_grace_period: 40s` must stay above `SHUTDOWN_TIMEOUT_MS = 30_000` in `main.ts`.** Docker's 10s default would SIGKILL mid-teardown, cutting a send in flight and stranding that row's `picked_at` lease (recoverable only by `releaseStaleLeases()` on the next boot) — and a SIGKILL landing inside `useMultiFileAuthState`'s non-atomic `writeFile` truncates a live pairing's `creds.json`. Raise one and you raise the other. `BOOT_RESTORE_TIMEOUT_MS` is the same 30s on the boot side, racing `restoreAll()` so a wedged pairing can't hold the poller back.
- **`useContactsStore.getState().reset()` on logout is load-bearing**, not tidiness: `loaded` latches, and logout is an SPA transition with no reload anywhere, so without it the next user signing in on the same tab sees the previous user's recent contacts. Any future store that caches per-user data must be reset in the same place (`stores/auth.ts`).
- `@inquirer/prompts` needs a TTY — anything piping stdin must use the `scripts/test-*` helpers instead.
- **`backend/.env` must exist before any `docker compose` command**, including `typecheck` and `lint` — the dev compose file declares `env_file`, so compose aborts before your command runs if it's missing. `cp backend/.env.example backend/.env` first. To check types without one: `docker build -q -t promitto-backend-check -f backend/Dockerfile.dev backend && docker run --rm promitto-backend-check sh -c "npm run typecheck && npm run lint"`.
- **`AppHeader` owns the SSE stream and is mounted by the `AppLayout` layout route**, so it survives navigation and its subscribe effect runs *once per page load*. That is the point — rendered per-page it reopened the stream on every route change. The consequence: nothing remounts it, so anything that needs the stream re-opened must go through the store, which is why the give-up path releases the `subscribed` guard and the header shows an explicit **Reconnect** button.
- **The SSE retry cap is sized against a deploy, not a network blip.** `MAX_CONSECUTIVE_FAILURES` in `api/sse.ts` is 10 against the browser's ~3s `EventSource` retry, i.e. ~30s — comfortably longer than the ~13s a container recreate takes. Lower it and an ordinary deploy strands every open tab reading "stale" until someone reloads.
- **The SPA fallback refuses paths whose last segment contains a dot.** Without that it answered `/robots.txt` with `index.html`, which a validator then read as 26 broken directives, and made every `/.env` probe look like a hit. It also answers `HEAD`, not just `GET` — it used to 404 on `HEAD /app`, which is enough to make an uptime monitor report the site down.
- **Route splitting is deliberately limited to `/app/wa`.** It is the only `qrcode` import site, worth ~10KB gzip. Lazy-loading the other six routes was measured at ~3.5KB more and rejected — don't add Suspense boundaries expecting a win.
