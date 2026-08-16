# Promitto — Tier 1 Privacy Pack

Date: 2026-08-17
Branch: `feat/privacy-tier1`
Status: design approved, pending implementation plan

## Problem

Promitto is self-hosted on the owner's personal VPS and provisioned for friends. A user
handing over their WhatsApp pairing is trusting the operator with more than they may
realise. As of `main` @ `975348e` the app holds, per user:

| Data | Location | Retained |
|---|---|---|
| Message bodies | `scheduled_messages.message_text` | forever |
| Message bodies | `sent_messages.message_text_snapshot` | forever |
| Full address book (name + phone) | `contacts`, auto-synced on pair | forever |
| WhatsApp account access | `backend/data/sessions/{userId}/` | until unpaired |
| Full client IP + user agent | `sessions.ip`, `sessions.user_agent` | up to 90d |

Logging is already clean: `lib/logger.ts` redacts `message_text` and
`message_text_snapshot`, and `middleware/logger.ts` records only method/url/status/duration.
The exposure is the database and the bind mount, not the logs.

**What this design does not claim to fix.** The operator has root on the box. The scheduler
must hold plaintext to send while the user is offline, which rules out password-derived or
client-held keys. No app-level change hides message content from the operator. This design
reduces how much data exists, for how long, and makes all of it visible and deletable by the
user. Encryption at rest (protects against disk/snapshot theft, not the operator) is Tier 2
and explicitly out of scope here.

## Scope

In scope:

1. Configurable retention, default 60 days, no "forever" option.
2. A sweeper that hard-deletes expired history and finished one-off schedules.
3. User-initiated "delete my data" (history purge, synced-contacts purge).
4. User-initiated account deletion, including WhatsApp device unlink.
5. Contact sync becomes a visible, reversible toggle (opt-out; grandfathered ON).
6. Stop storing full client IPs.
7. A plain-language privacy page, readable without an account.

Out of scope: encryption at rest, backups, changes to what the superuser can see,
per-user self-hosting tooling.

## Decisions taken during design

- **Contact sync defaults ON for existing and new users**, with a toggle to disable and an
  action to delete already-synced contacts. Honestly labelled opt-out, not opt-in. Defaulting
  OFF would silently stop Recent-contact updates for every currently paired user.
- **Retention hard-deletes rows** rather than redacting text in place. Nothing lingers — no
  body, no recipient, no timestamp. Redaction would leave a permanent who-messaged-whom-when
  record, which undercuts the point, and would require making the column nullable.
- **Account deletion unlinks the device from the phone** (`sock.logout()`) before wiping, so
  the user can verify on their own device that Promitto is gone.
- **First sweep is validated locally against seeded synthetic data**, never dry-run against
  production. Production deploys with the sweeper armed.

## Design

### 1. Schema migration (additive only)

Edit `backend/src/db/schema.ts`, then generate the migration with
`docker compose exec backend npm run db:generate` — do not hand-write the file. Read the
generated SQL before applying it and confirm it contains only the two `ALTER TABLE ... ADD
COLUMN` statements below; Drizzle will silently emit a table rebuild if the schema edit
strays, and that is the one thing this project cannot afford.

```sql
ALTER TABLE users ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 60;
ALTER TABLE users ADD COLUMN contact_sync_enabled INTEGER NOT NULL DEFAULT 1;
```

Both columns carry a `NOT NULL DEFAULT`, so the previous release still boots against the new
schema — mandatory, because per `CLAUDE.md` there are no backups and rolling the image back
does not roll the schema back.

`sessions.ip` is **not dropped**. Dropping a column in SQLite is a table rebuild, exactly the
class of migration to avoid here. Existing values cannot be truncated in pure SQL, so the
generated migration gets one hand-appended statement that discards them outright:

```sql
UPDATE sessions SET ip = NULL;
```

The column is already nullable. New rows are written pre-truncated by the write path below.

### 2. IP truncation

`lib/ip.ts` (new): `anonymizeIp(ip: string | null): string | null` — zeroes the last octet
of IPv4 (`/24`) and the last 80 bits of IPv6 (`/48`), returns `null` for unparseable input.

Applied at `modules/auth/routes.ts:72` where `req.ip` is written to the session row. The
login rate limiter at `routes.ts:44-47` continues to use the full `req.ip`; it is in-memory,
never persisted, and cleared on restart.

### 3. Retention sweeper

New module `backend/src/modules/privacy/retention.ts`, a singleton mirroring
`scheduler/poller.ts`: `start()` / `stop()`, an interval, and a `sweeping` re-entrancy guard.
Started from `main.ts` immediately after `schedulerPoller.start()`, stopped alongside it in
`shutdown()`.

- Runs once at boot, then every 6 hours.
- Iterates users, computing `cutoff = now - retention_days * 86_400_000` per user.
- One `sqlite.transaction().immediate()` per sweep:

```sql
DELETE FROM sent_messages
  WHERE user_id = ? AND sent_at < ?;

DELETE FROM scheduled_messages
  WHERE user_id = ? AND is_active = 0
    AND schedule_type = 'once' AND updated_at < ?;
```

Active rows and recurring rows are never touched, regardless of age. `sent_messages
.scheduled_message_id` carries no foreign key, so deleting either table in either order is
safe.

`RETENTION_DRY_RUN` (boolean env, default `false`) makes the sweeper `SELECT count(*)` and
log what it would delete without deleting. It exists as a safety valve and as the mechanism
for local verification; production runs with it off.

Logs one `info` line per sweep with per-user deleted counts, or `debug` when nothing expired.

Allowed values for `retention_days`: **7, 30, 60, 90, 180**. Default 60. No unlimited option.

### 4. Contact sync toggle

The `contacts.upsert` and `contacts.update` handlers in `modules/wa-sessions/manager.ts`
check the owning user's `contact_sync_enabled` before writing. The flag is read from SQLite
inside the handler rather than cached on the `Handle` — better-sqlite3 is synchronous and the
read is cheap, and this stays correct when a user toggles mid-session with no cache to
invalidate.

Turning the toggle off stops new writes; it does not retroactively delete. Deletion is the
separate explicit action below.

### 5. API surface

All routes sit under the existing router-level gating
(`requireAuth`, `requirePasswordRotated`, `requireCsrf`) — no per-route gating, per the
convention in `CLAUDE.md`.

| Route | Body | Effect |
|---|---|---|
| `POST /api/settings/retention` | `{ retentionDays: 7\|30\|60\|90\|180 }` | updates the column; next sweep applies it |
| `POST /api/settings/contact-sync` | `{ enabled: boolean }` | updates the column |
| `POST /api/settings/purge-data` | `{ currentPassword }` | deletes all of this user's `sent_messages` and inactive `once` rows, ignoring retention |
| `POST /api/contacts/purge-synced` | — | `DELETE FROM contacts WHERE user_id = ? AND source = 'synced'` |

| `DELETE /api/settings/account` | `{ currentPassword, confirm: "DELETE" }` | full account deletion, below |

`purge-data` and `DELETE /account` require the password; `purge-synced` deliberately does
not. Synced contacts are recoverable — reconnect with the toggle on and they repopulate —
whereas message history and the account itself are gone for good. The friction matches the
consequence rather than being applied uniformly.

`lib/user.ts`'s `serializeUser` gains `retentionDays` and `contactSyncEnabled`. As always, no
raw DB row is returned.

### 6. Account deletion flow

In `modules/settings/routes.ts`:

1. `verifyPassword(user.passwordHash, body.currentPassword)` — 401 on mismatch.
2. `body.confirm === 'DELETE'` — 400 otherwise.
3. If the user is a superuser and the last remaining one, 409 `last_superuser`. Prevents
   locking the instance out of admin.
4. `await sessionManager.disconnect(userId, { logout: true })` — already unlinks the device
   and wipes the auth dir (`manager.ts:461-466`). Wrapped in try/catch with a timeout; a
   WhatsApp failure logs a warning and must never block the deletion.
5. `deleteUserById(id)` — cascades `sessions`, `wa_connections`, `contacts`,
   `scheduled_messages`, `sent_messages`.
6. Re-assert removal of `${SESSIONS_DIR}/${userId}` in case step 4 failed.
7. Clear the `promitto_sid` and `promitto_csrf` cookies, respond 204.
8. One `info` audit line (`userId`, `email`, `'account self-deleted'`) so the event is on
   record.

This is irreversible and there is no backup. The password check, typed confirmation, and
last-superuser guard are the entire safety net; keep all three.

### 7. Frontend

`frontend/src/pages/Settings.tsx` gains two sections, using existing tokens only
(`ledger-card`, `eyebrow`, `accent-warm` for destructive, hairline rules between sections).
No new dependencies, no framer-motion.

**Privacy & data**
- Retention `<select>` (7/30/60/90/180 days) with a one-line explanation of what expires.
- "Sync WhatsApp contacts" toggle with a line stating what syncing collects.
- "Delete synced contacts" — confirm dialog, keeps manually added contacts.
- "Delete message history" — confirm dialog with password.

**Danger zone**
- "Delete my account" — modal requiring the password and typing `DELETE`, listing exactly
  what is destroyed (account, contacts, schedules, history, WhatsApp pairing) and stating it
  cannot be undone. On success, redirect to login with a confirmation notice.

**Privacy page**
New `frontend/src/pages/Privacy.tsx` at `/privacy`, registered **before** the `*` catch-all
and **outside** `RequireAuth`, so someone can read it before accepting an account. Linked
from the login page footer and from the Settings privacy section. Content is plain language:
what is stored, how long, that the operator has technical access to message text, that
WhatsApp pairing grants full account access, that there are no backups, and that anyone who
wants none of this can self-host their own copy from the compose file.

`api/settings.ts` and `api/contacts.ts` gain the matching wrappers; the `auth` store clears
on successful account deletion.

## Error handling

Existing conventions apply throughout: throw `errors.*()` from `lib/errors.ts`, let
`errorMiddleware` render the `{ error: { code, message, details? } }` envelope, and let zod
parse failures auto-convert to 400 `validation_error`.

Specific cases:
- WhatsApp unlink failure during account deletion → log `warn`, continue deleting.
- Sweeper throwing mid-transaction → the transaction rolls back, the error is logged, and
  the next sweep in 6h retries. A failed sweep must never crash the process or stop the
  interval.
- `purge-data` and `purge-synced` are idempotent; deleting zero rows is a 204, not an error.

## Verification

There is no test framework in this repo and this design does not introduce one. Verification
is `typecheck` + `lint` on both packages plus exercising the app, per `CLAUDE.md`.

```bash
docker compose exec backend  npm run typecheck && docker compose exec backend  npm run lint
docker compose exec frontend npm run typecheck && docker compose exec frontend npm run lint
```

Manual checks against a **locally seeded synthetic database** — never production data:

1. Seed `sent_messages` and finished `once` rows with `sent_at` / `updated_at` spanning both
   sides of the cutoff. Run with `RETENTION_DRY_RUN=true`; confirm the log names the right
   rows and the table is unchanged. Re-run with it off; confirm exactly those rows are gone
   and active + recurring rows survived.
2. Change retention to 7 days; confirm the next sweep uses the new cutoff.
3. Toggle contact sync off, trigger a contact update from the phone, confirm no write.
4. Purge synced contacts; confirm `source = 'manual'` rows survive.
5. Delete a throwaway account; confirm the cascade emptied all five child tables, the auth
   directory is gone, and the linked device disappeared from the phone.
6. Load `/privacy` while logged out.

## Risks

- **The sweeper is the only destructive automation in the app.** Its correctness rests on the
  `is_active = 0 AND schedule_type = 'once'` predicate. A mistake there deletes live
  schedules. This deserves the closest review in the change.
- **Account deletion is unrecoverable** and, by design, reachable by the user without
  operator involvement.
- **The migration must stay additive.** If the plan grows a column drop or a type change,
  stop and reconsider — rollback safety depends on it.
- The 60-day default is retroactive: on the first armed sweep in production, every user's
  history older than 60 days is deleted. This is the intended policy, taken knowingly.

## Amendment — 2026-08-17, rebased onto `c167ac5`

This spec was drafted against `975348e`. Six PRs (#7–#12) landed in between. The following
claims above are superseded; the implementation plan
(`docs/superpowers/plans/2026-08-17-privacy-tier1.md`) is written against the current tree
and wins wherever the two disagree.

1. **`contacts` now stores behavioural data.** `last_interaction_at` and `wa_pinned_at`
   (both nullable) record when the user last interacted with each contact and which chats
   they pin on WhatsApp. This is at least as sensitive as the address book itself and the
   original spec did not account for it.
2. **The contact-sync gate covers three write sites, not one.** `manager.ts` persists
   contact-derived data from `upsertSynced` (~:897), `recordInteractions` (~:824) and
   `recordPinStates` (~:837). Gating only `contacts.upsert`/`contacts.update` would leave
   recency and pin mirroring writing while the user believes syncing is off.
3. **`purgeSynced` must also clear behavioural fields on manual contacts.** Deleting
   `source = 'synced'` rows alone leaves manually-added contacts carrying
   `last_interaction_at` and `wa_pinned_at` — a surviving record of who the user talks to
   and when, after they asked for it to be deleted.
4. **A real verification harness exists**: `backend/scripts/test-interaction-flush.ts`,
   `node:assert/strict` against a throwaway migrated SQLite file. The sweeper gets an
   equivalent (`test-retention-sweep.ts`) rather than manual checking. This is still not a
   test framework and none is being introduced.
5. **Avatars need no deletion handling** — `GET /api/contacts/:id/avatar` 302-redirects to
   the WhatsApp CDN; nothing is stored on disk.
6. **Boot order changed.** `main.ts` now runs restore → poller → supervisor → memory monitor.
   The sweeper starts last and stops first, following the `memoryMonitor` pattern.
7. Cascade coverage is unchanged: all child tables still cascade from `users`, and PRs #7–#12
   added no new tables.

## Follow-ups (not this change)

- Tier 2: encryption at rest for `message_text` and the Baileys auth state, keyed from the
  environment. Protects against disk or snapshot theft, not against the operator.
- Documented self-hosting path for users who want no operator access at all.
