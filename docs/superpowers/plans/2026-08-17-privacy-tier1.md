# Tier 1 Privacy Pack — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Promitto users control over how long their data lives, the ability to delete it, a visible switch for WhatsApp contact syncing, and an honest privacy page — without weakening the scheduler or risking the un-backed-up production database.

**Architecture:** Two additive `users` columns drive a new periodic sweeper module that hard-deletes expired history. New settings/contacts routes expose retention, sync, purge and account deletion. The WhatsApp manager gains a per-user gate before every write of contact-derived data. The frontend gets a Privacy & data section, a Danger zone, and a public `/privacy` page.

**Tech Stack:** TypeScript, Express, Drizzle ORM, better-sqlite3 (synchronous), Baileys, React 18 + Vite + Zustand v5 + React Router v6, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-17-privacy-tier1-design.md` — read it before starting. Where this plan and the spec disagree, **this plan wins** (it is written against `c167ac5`; the spec was written against `975348e` and its Amendment section records the deltas).

## Global Constraints

- **Worktree:** all work happens in `/Users/faza/repos/personal/worktrees/promitto-feat-privacy-tier1` on branch `feat/privacy-tier1`. Never touch `/Users/faza/repos/personal/promitto`.
- **No TDD.** Implement first, then write verification scripts. Do not write tests before implementation.
- **No test framework exists.** Verification is `typecheck` + `lint` + the two `node:assert/strict` scripts. Do not add a runner, do not add dependencies.
- **The migration must be additive only.** `ADD COLUMN` with `NOT NULL DEFAULT` only. No column drops, no type changes, no table rebuilds. Production has **no backups**; a table rebuild that fails is unrecoverable data loss for every user.
- **Never return a raw DB row** — always go through a serializer in `lib/`.
- **Timestamps** serialize as epoch-ms numbers, never ISO strings.
- **Errors**: throw `errors.*()` from `lib/errors.ts`; let `errorMiddleware` render the envelope.
- **Design tokens only** on the frontend: `paper*`, `ink*`, `rule*`, `accent`, `accent-warm`, `amber-soft`. No `slate-*`/`emerald-*`/`red-*`. `font-mono` only for machine data. No new frontend dependencies, no framer-motion.
- **Retention values** are exactly `7 | 30 | 60 | 90 | 180` days. Default `60`. There is no "forever".
- Run backend commands as `docker compose exec backend <cmd>`; `backend/.env` must exist first.

---

### Task 1: Schema, IP truncation, serializer, env

**Files:**
- Modify: `backend/src/db/schema.ts` (`users` table)
- Create: `backend/drizzle/0007_*.sql` (generated, then hand-edited)
- Create: `backend/src/lib/ip.ts`
- Modify: `backend/src/modules/auth/routes.ts` (the `ip:` field passed to session creation)
- Modify: `backend/src/lib/user.ts`
- Modify: `backend/src/config/env.ts`
- Modify: `backend/.env.example`

**Interfaces produced (later tasks depend on these exact names):**
- `users.retentionDays: number` (column `retention_days`)
- `users.contactSyncEnabled: boolean` (column `contact_sync_enabled`)
- `anonymizeIp(ip: string | null | undefined): string | null` from `lib/ip.js`
- `UserPublic` gains `retentionDays: number` and `contactSyncEnabled: boolean`
- `env.RETENTION_DRY_RUN: boolean`

- [ ] **Step 1: Add the two columns to `users` in `backend/src/db/schema.ts`**

Add inside the `users` table definition, after `mustChangePassword`:

```ts
  retentionDays: integer('retention_days').notNull().default(60),
  contactSyncEnabled: integer('contact_sync_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
```

- [ ] **Step 2: Generate the migration**

Run: `docker compose exec backend npm run db:generate`

- [ ] **Step 3: Read the generated SQL and verify it is additive**

Open the new `backend/drizzle/0007_*.sql`. It MUST contain only:

```sql
ALTER TABLE `users` ADD `retention_days` integer DEFAULT 60 NOT NULL;
ALTER TABLE `users` ADD `contact_sync_enabled` integer DEFAULT true NOT NULL;
```

**If it contains `PRAGMA foreign_keys=OFF`, `CREATE TABLE __new_users`, `INSERT INTO __new_users`, or `DROP TABLE`, STOP.** That is a table rebuild. Revert the schema edit and report the problem rather than proceeding.

- [ ] **Step 4: Hand-append the IP discard to the same migration file**

Existing IPs cannot be truncated in pure SQL, so discard them. Append to the generated file:

```sql
--> statement-breakpoint
UPDATE `sessions` SET `ip` = NULL;
```

- [ ] **Step 5: Apply the migration**

Run: `docker compose exec backend npm run db:migrate`
Expected: completes without error.

- [ ] **Step 6: Create `backend/src/lib/ip.ts`**

```ts
/**
 * Reduce a client IP to a coarse network prefix before it is persisted.
 * We keep enough to distinguish networks for debugging and drop enough that a
 * stored session row no longer identifies a household. Rate limiting is
 * in-memory and keeps using the full address; only the DB sees this.
 */
export function anonymizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;

  // Express reports IPv4-mapped IPv6 as "::ffff:1.2.3.4".
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  if (mapped.includes('.') && !mapped.includes(':')) {
    const parts = mapped.split('.');
    if (parts.length !== 4 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) {
      return null;
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  if (mapped.includes(':')) {
    const expanded = expandIpv6(mapped);
    if (!expanded) return null;
    return `${expanded.slice(0, 3).join(':')}::/48`;
  }

  return null;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  if (ip.includes('::')) {
    const fill = 8 - headParts.length - tailParts.length;
    if (fill < 0) return null;
    return [...headParts, ...Array(fill).fill('0'), ...tailParts];
  }
  const parts = ip.split(':');
  return parts.length === 8 ? parts : null;
}
```

- [ ] **Step 7: Apply it at the session write site**

In `backend/src/modules/auth/routes.ts`, import `anonymizeIp` from `../../lib/ip.js` and change the session-creation call so `ip: req.ip ?? null` becomes:

```ts
        ip: anonymizeIp(req.ip),
```

**Do not change the rate-limit call** near the top of the login handler — `loginIpBucket.take(ip)` must keep using the full `req.ip`. It is in-memory and never persisted.

- [ ] **Step 8: Extend the user serializer**

In `backend/src/lib/user.ts`, add `retentionDays: number;` and `contactSyncEnabled: boolean;` to `UserPublic`, and in `serializeUser` add:

```ts
    retentionDays: u.retentionDays,
    contactSyncEnabled: u.contactSyncEnabled,
```

- [ ] **Step 9: Add the dry-run env var**

In `backend/src/config/env.ts`, add to `EnvSchema` (follow the existing `TRUST_PROXY` idiom exactly):

```ts
  RETENTION_DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
```

Add to `backend/.env.example`:

```
# When true the retention sweeper logs what it would delete and deletes nothing.
RETENTION_DRY_RUN=false
```

- [ ] **Step 10: Verify**

Run: `docker compose exec backend npm run typecheck && docker compose exec backend npm run lint`
Expected: both pass.

- [ ] **Step 11: Commit**

```bash
git add backend/src/db/schema.ts backend/drizzle backend/src/lib/ip.ts \
        backend/src/lib/user.ts backend/src/modules/auth/routes.ts \
        backend/src/config/env.ts backend/.env.example
git commit -m "feat(privacy): add retention + contact-sync columns, truncate stored IPs"
```

---

### Task 2: Retention sweeper

**Files:**
- Create: `backend/src/modules/privacy/retention.ts`
- Modify: `backend/src/main.ts`
- Create: `backend/scripts/test-retention-sweep.ts`

**Interfaces consumed:** `users.retentionDays` (Task 1), `env.RETENTION_DRY_RUN` (Task 1).

**Interfaces produced:**
- `retentionSweeper` singleton with `start(): void`, `stop(): Promise<void>`
- `sweepUser(userId: string, retentionDays: number, now?: number): { sentMessages: number; scheduledMessages: number }` — exported for the verification script

- [ ] **Step 1: Create `backend/src/modules/privacy/retention.ts`**

Model the singleton on `backend/src/modules/scheduler/poller.ts` — read that file first and match its `start`/`stop`/re-entrancy-guard idiom.

```ts
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db/client.js';
import { scheduledMessages, sentMessages, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export type SweepCounts = { sentMessages: number; scheduledMessages: number };

/**
 * Delete one user's expired data. Hard delete, not redaction: a retained row
 * would still record who was messaged and when, which is the thing retention is
 * meant to stop keeping.
 *
 * Only finished one-off schedules expire. Active rows and every recurring row
 * survive regardless of age — a recurring schedule is live configuration, not
 * history, and deleting one would silently stop a user's messages.
 */
export function sweepUser(userId: string, retentionDays: number, now = Date.now()): SweepCounts {
  const cutoff = new Date(now - retentionDays * DAY_MS);

  if (env.RETENTION_DRY_RUN) {
    const sent = db
      .select({ n: sql<number>`count(*)` })
      .from(sentMessages)
      .where(and(eq(sentMessages.userId, userId), lt(sentMessages.sentAt, cutoff)))
      .get();
    const sched = db
      .select({ n: sql<number>`count(*)` })
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.userId, userId),
          eq(scheduledMessages.isActive, false),
          eq(scheduledMessages.scheduleType, 'once'),
          lt(scheduledMessages.updatedAt, cutoff),
        ),
      )
      .get();
    return { sentMessages: sent?.n ?? 0, scheduledMessages: sched?.n ?? 0 };
  }

  const run = sqlite.transaction(() => {
    const sent = db
      .delete(sentMessages)
      .where(and(eq(sentMessages.userId, userId), lt(sentMessages.sentAt, cutoff)))
      .run();
    const sched = db
      .delete(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.userId, userId),
          eq(scheduledMessages.isActive, false),
          eq(scheduledMessages.scheduleType, 'once'),
          lt(scheduledMessages.updatedAt, cutoff),
        ),
      )
      .run();
    return { sentMessages: sent.changes, scheduledMessages: sched.changes };
  });

  return run.immediate();
}

class RetentionSweeper {
  private interval: NodeJS.Timeout | undefined;
  private sweeping = false;

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, SWEEP_INTERVAL_MS);
    logger.info(
      { intervalMs: SWEEP_INTERVAL_MS, dryRun: env.RETENTION_DRY_RUN },
      'retention sweeper started',
    );
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    return Promise.resolve();
  }

  private async tick(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db
        .select({ id: users.id, retentionDays: users.retentionDays })
        .from(users)
        .all();
      let sent = 0;
      let scheduled = 0;
      for (const row of rows) {
        try {
          const counts = sweepUser(row.id, row.retentionDays);
          sent += counts.sentMessages;
          scheduled += counts.scheduledMessages;
        } catch (err) {
          logger.error({ err, userId: row.id }, 'retention sweep failed for user');
        }
      }
      if (sent > 0 || scheduled > 0) {
        logger.info(
          { sentMessages: sent, scheduledMessages: scheduled, dryRun: env.RETENTION_DRY_RUN },
          env.RETENTION_DRY_RUN ? 'retention sweep (dry run)' : 'retention sweep complete',
        );
      } else {
        logger.debug('retention sweep found nothing to delete');
      }
    } catch (err) {
      logger.error({ err }, 'retention sweep tick failed');
    } finally {
      this.sweeping = false;
    }
  }
}

export const retentionSweeper = new RetentionSweeper();
```

Note: check how `db/client.ts` exports the raw handle. If it is not named `sqlite`, use whatever `scheduler/service.ts` imports for its `BEGIN IMMEDIATE` transactions and match that.

- [ ] **Step 2: Wire into `backend/src/main.ts`**

Read the current boot sequence first. Start the sweeper **last**, after `memoryMonitor.start()`, so its first pass does not compete with boot. In `shutdown()`, stop it **first**, before the memory monitor, mirroring reverse order. Add the import and:

```ts
  retentionSweeper.start();
```

and in the teardown block, before the existing monitor stop:

```ts
    try {
      await retentionSweeper.stop();
    } catch (err) {
      logger.error({ err }, 'retentionSweeper.stop failed');
    }
```

- [ ] **Step 3: Write the verification script**

Create `backend/scripts/test-retention-sweep.ts` modelled on `backend/scripts/test-interaction-flush.ts` — read that file first and copy its structure exactly: throwaway SQLite file, run migrations against it, `node:assert/strict`, delete the file at the end, exit non-zero on first failure. **It must never touch the dev database.**

Assertions required:
1. A `sent_messages` row older than the cutoff is deleted.
2. A `sent_messages` row newer than the cutoff survives.
3. An inactive `once` `scheduled_messages` row older than the cutoff is deleted.
4. An **active** `once` row older than the cutoff **survives**.
5. An inactive **recurring** row older than the cutoff **survives**.
6. A second user's old rows are untouched when sweeping the first user (tenancy).
7. Changing `retentionDays` from 60 to 7 changes which rows expire.
8. With `RETENTION_DRY_RUN=true`, counts are reported and **no rows are deleted**.

Assertions 4 and 5 are the ones that matter most — they are what stops the sweeper deleting live schedules.

- [ ] **Step 4: Run the verification script**

Run: `docker compose exec backend npx tsx scripts/test-retention-sweep.ts`
Expected: all assertions pass, exit 0.

- [ ] **Step 5: Verify types and lint**

Run: `docker compose exec backend npm run typecheck && docker compose exec backend npm run lint`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/privacy backend/src/main.ts backend/scripts/test-retention-sweep.ts
git commit -m "feat(privacy): add retention sweeper with dry-run mode and verification script"
```

---

### Task 3: Backend API — retention, sync toggle, purges, account deletion

**Files:**
- Modify: `backend/src/modules/users/service.ts`
- Modify: `backend/src/modules/contacts/service.ts`
- Modify: `backend/src/modules/contacts/routes.ts`
- Modify: `backend/src/modules/settings/routes.ts`
- Modify: `backend/src/modules/wa-sessions/manager.ts`

**Interfaces consumed:** `users.retentionDays`, `users.contactSyncEnabled` (Task 1); `sweepUser` is NOT used here — purges ignore retention and delete everything.

**Interfaces produced (Task 4 depends on these exact shapes):**
- `POST /api/settings/retention` body `{ retentionDays: 7|30|60|90|180 }` → `200` `UserPublic`
- `POST /api/settings/contact-sync` body `{ enabled: boolean }` → `200` `UserPublic`
- `POST /api/settings/purge-data` body `{ currentPassword: string }` → `200` `{ sentMessages: number, scheduledMessages: number }`
- `DELETE /api/settings/account` body `{ currentPassword: string, confirm: "DELETE" }` → `204`
- `POST /api/contacts/purge-synced` no body → `200` `{ deleted: number, cleared: number }`

- [ ] **Step 1: Add users service helpers**

In `backend/src/modules/users/service.ts`, following the existing `setTimezone` idiom:

```ts
export function setRetentionDays(id: string, retentionDays: number): void {
  db.update(users)
    .set({ retentionDays, updatedAt: new Date() })
    .where(eq(users.id, id))
    .run();
}

export function setContactSyncEnabled(id: string, enabled: boolean): void {
  db.update(users)
    .set({ contactSyncEnabled: enabled, updatedAt: new Date() })
    .where(eq(users.id, id))
    .run();
}

export function isContactSyncEnabled(id: string): boolean {
  const row = db
    .select({ enabled: users.contactSyncEnabled })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return row?.enabled ?? false;
}

export function countSuperusers(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, 'superuser'))
    .get();
  return row?.n ?? 0;
}
```

Import `sql` from `drizzle-orm` if not already imported.

- [ ] **Step 2: Add the contacts purge to `backend/src/modules/contacts/service.ts`**

```ts
/**
 * Remove everything contact syncing produced. Synced rows go entirely; manual
 * rows are kept but stripped of the behavioural fields, because interaction
 * recency and WhatsApp pin state are derived from WA events too and would
 * otherwise survive a "delete my synced data" as a record of who the user
 * talks to and when.
 */
export function purgeSynced(userId: string): { deleted: number; cleared: number } {
  const deleted = db
    .delete(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.source, 'synced')))
    .run();
  const cleared = db
    .update(contacts)
    .set({ lastInteractionAt: null, waPinnedAt: null, updatedAt: new Date() })
    .where(eq(contacts.userId, userId))
    .run();
  return { deleted: deleted.changes, cleared: cleared.changes };
}
```

- [ ] **Step 3: Add the purge route to `backend/src/modules/contacts/routes.ts`**

Register it **above** the `/:id` routes so the literal path is matched first:

```ts
contactsRouter.post('/purge-synced', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const result = service.purgeSynced(req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Gate the three WhatsApp write sites in `backend/src/modules/wa-sessions/manager.ts`**

There are three places that persist contact-derived data. All three must check the user's toggle. Import `isContactSyncEnabled` from `../users/service.js`.

At the `recordInteractions` call site (~line 824), the `recordPinStates` call site (~line 837), and the `upsertSynced` call site (~line 897), wrap each in:

```ts
      if (!isContactSyncEnabled(h.userId)) return;
```

placed so the batch is still drained/cleared (do not leak a growing buffer when sync is off — read the surrounding flush logic and make sure the queue is emptied either way).

Read the DB per flush rather than caching on the `Handle`: better-sqlite3 is synchronous and this is a cheap indexed read, and it stays correct when the user toggles mid-session with no cache to invalidate.

- [ ] **Step 5: Add the settings routes**

In `backend/src/modules/settings/routes.ts`, following the existing `handleTz`/password idioms. Note the router is already gated by `requireAuth, requireCsrf`; add `requirePasswordRotated` per route as the timezone route does.

```ts
const RetentionBody = z.object({
  retentionDays: z.union([
    z.literal(7),
    z.literal(30),
    z.literal(60),
    z.literal(90),
    z.literal(180),
  ]),
});

settingsRouter.post('/retention', requirePasswordRotated, (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = RetentionBody.parse(req.body);
    setRetentionDays(req.user.id, body.retentionDays);
    const updated = findUserById(req.user.id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

const ContactSyncBody = z.object({ enabled: z.boolean() });

settingsRouter.post('/contact-sync', requirePasswordRotated, (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = ContactSyncBody.parse(req.body);
    setContactSyncEnabled(req.user.id, body.enabled);
    const updated = findUserById(req.user.id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

const PurgeBody = z.object({ currentPassword: z.string().min(1).max(1024) });

settingsRouter.post('/purge-data', requirePasswordRotated, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) throw errors.unauthorized();
    const body = PurgeBody.parse(req.body);
    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw errors.unauthorized('Current password is incorrect');

    // retentionDays 0 == cutoff is now == delete everything that has already happened
    const counts = sweepUser(user.id, 0);
    logger.info({ userId: user.id, ...counts }, 'user purged their message data');
    res.json(counts);
  } catch (err) {
    next(err);
  }
});
```

**Important:** `sweepUser` respects `RETENTION_DRY_RUN`. A user-initiated purge must delete for real regardless. Either add an explicit `opts: { dryRun?: boolean }` parameter to `sweepUser` defaulting to `env.RETENTION_DRY_RUN` and pass `{ dryRun: false }` here, or factor the delete out into a non-gated internal function. Do one of these — do not leave the purge silently no-op under dry run.

- [ ] **Step 6: Add account deletion**

```ts
const DeleteAccountBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  confirm: z.literal('DELETE'),
});

settingsRouter.delete('/account', requirePasswordRotated, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) throw errors.unauthorized();
    const body = DeleteAccountBody.parse(req.body);

    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw errors.unauthorized('Current password is incorrect');

    if (user.role === 'superuser' && countSuperusers() <= 1) {
      throw errors.conflict(
        'You are the only superuser. Promote another account before deleting this one.',
      );
    }

    // Unlink the device from the user's phone so they can verify on their own
    // handset that Promitto is gone. A WhatsApp failure must never block the
    // deletion — the local data still goes.
    try {
      await sessionManager.disconnect(user.id, { logout: true });
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'wa logout failed during account deletion');
    }

    deleteUserById(user.id);
    logger.info({ userId: user.id, email: user.email }, 'account self-deleted');

    clearSessionCookies(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

For `clearSessionCookies`, read `backend/src/modules/auth/routes.ts` and reuse exactly however the logout handler clears `promitto_sid` and `promitto_csrf` — extract it to a shared helper if it is inline, rather than duplicating cookie options.

After `deleteUserById`, re-assert removal of the auth directory in case the WhatsApp disconnect failed before wiping:

```ts
    await fs.rm(path.join(env.SESSIONS_DIR, user.id), { recursive: true, force: true });
```

- [ ] **Step 7: Verify**

Run: `docker compose exec backend npm run typecheck && docker compose exec backend npm run lint`
Expected: both pass.

Run: `docker compose exec backend npx tsx scripts/test-interaction-flush.ts`
Expected: 9/9 assertions still pass — Step 4 touched that code path.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules
git commit -m "feat(privacy): retention + sync settings, data purge, self-service account deletion"
```

---

### Task 4: Frontend — Privacy & data, Danger zone, /privacy page

**Files:**
- Modify: `frontend/src/api/settings.ts`
- Modify: `frontend/src/api/contacts.ts`
- Modify: `frontend/src/pages/Settings.tsx`
- Create: `frontend/src/pages/Privacy.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces consumed:** the five routes listed in Task 3's "Interfaces produced". `UserPublic` now carries `retentionDays` and `contactSyncEnabled` (Task 1) — update the frontend `User` type to match.

- [ ] **Step 1: Add the API wrappers**

In `frontend/src/api/settings.ts`, match the existing `apiRequest` idiom:

```ts
export function setRetention(retentionDays: number) {
  return apiRequest<User>('/api/settings/retention', {
    method: 'POST',
    body: { retentionDays },
  });
}

export function setContactSync(enabled: boolean) {
  return apiRequest<User>('/api/settings/contact-sync', {
    method: 'POST',
    body: { enabled },
  });
}

export function purgeData(currentPassword: string) {
  return apiRequest<{ sentMessages: number; scheduledMessages: number }>(
    '/api/settings/purge-data',
    { method: 'POST', body: { currentPassword } },
  );
}

export function deleteAccount(currentPassword: string) {
  return apiRequest<void>('/api/settings/account', {
    method: 'DELETE',
    body: { currentPassword, confirm: 'DELETE' },
  });
}
```

Read the real signature of `apiRequest` first and conform to it — the `body` key above is illustrative, not assumed.

In `frontend/src/api/contacts.ts`:

```ts
export function purgeSynced() {
  return apiRequest<{ deleted: number; cleared: number }>('/api/contacts/purge-synced', {
    method: 'POST',
  });
}
```

- [ ] **Step 2: Add the "Privacy & data" section to `Settings.tsx`**

Place it after the Password section, matching the existing `<section className="border-b border-rule pb-8">` + `<div className="eyebrow">` structure. Contents:

- A `<select>` bound to `user.retentionDays` with options 7/30/60/90/180, labelled in days, calling `setRetention` on change and updating the auth store's user. Supporting copy: "Sent history and finished one-off schedules are deleted permanently after this long. There is no unlimited option."
- A checkbox bound to `user.contactSyncEnabled` calling `setContactSync`. Copy: "Sync contacts, pins and recent-chat activity from WhatsApp. Turning this off stops new syncing; it does not delete what is already stored."
- A "Delete synced contacts" button calling `purgeSynced`, behind a `window.confirm`. On success show how many were deleted.
- A "Delete message history" button opening a small inline password form, calling `purgeData`. On success show the counts.

- [ ] **Step 3: Add the Danger zone**

A final `<section>` using `accent-warm` for the destructive affordance. A "Delete my account" button opens a modal requiring:
- the current password,
- typing `DELETE` into a text input (submit disabled until it matches exactly).

The modal must list what is destroyed: account, contacts, schedules, message history, and the WhatsApp pairing. State plainly that it cannot be undone and that there are no backups.

On success: clear the auth store and `navigate('/login', { replace: true })`.

- [ ] **Step 4: Create `frontend/src/pages/Privacy.tsx`**

A static page, no data fetching, readable logged out. Use `font-display` for headings and `.ledger-card` / hairline rules to match the rest of the app. Prose in `font-sans` — **not** mono. Cover, honestly:

- Promitto runs on one personal VPS operated by an individual, not a company.
- What is stored: account email, message text of scheduled and sent messages, contacts (names and numbers) synced from WhatsApp, when you last interacted with each contact and which chats you pin, and a coarse network prefix for login sessions.
- How long: message history and finished one-off schedules are deleted after the retention period you choose, 60 days by default.
- **The operator has technical access to the server and can read message text.** Messages must be stored in readable form because they are sent while you are offline. Do not claim end-to-end encryption.
- Linking WhatsApp grants this server the ability to send and receive as you; you can unlink at any time from your phone or by deleting your account.
- There are no backups. Deleted means gone.
- Anyone who does not want to trust the operator can self-host their own copy — link the repo.

- [ ] **Step 5: Register the route**

In `frontend/src/App.tsx`, add **before** the `path="*"` catch-all at the end and **outside** `RequireAuth`:

```tsx
        <Route path="/privacy" element={<Privacy />} />
```

Add a link to `/privacy` in the login page footer and from the Settings privacy section.

- [ ] **Step 6: Verify**

Run: `docker compose exec frontend npm run typecheck && docker compose exec frontend npm run lint`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(privacy): privacy & data settings, danger zone, public privacy page"
```

---

### Task 5: Docs, full verification, PR

- [ ] **Step 1: Update `CLAUDE.md`**

Add a `## Privacy & retention` section covering: the two new `users` columns, the sweeper's schedule and its exact predicate, `RETENTION_DRY_RUN`, the three gated WA write sites, and that account deletion is user-reachable and unrecoverable. Add the new routes to the router table. Add `scripts/test-retention-sweep.ts` to the commands block and to the note about `test-*` scripts.

- [ ] **Step 2: Full verification**

```bash
docker compose exec backend  npm run typecheck && docker compose exec backend  npm run lint
docker compose exec frontend npm run typecheck && docker compose exec frontend npm run lint
docker compose exec backend npx tsx scripts/test-retention-sweep.ts
docker compose exec backend npx tsx scripts/test-interaction-flush.ts
```

All four must pass. Report actual output; do not claim success without it.

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "docs: record privacy pack behaviour and retention invariants"
git push -u origin feat/privacy-tier1
```

- [ ] **Step 4: Open the PR**

Title: `Privacy: configurable retention, data deletion, contact-sync toggle`

Body must call out: the additive-only migration, that the 60-day default is retroactive on first sweep, the `is_active = 0 AND schedule_type = 'once'` predicate as the highest-risk line, and that account deletion is unrecoverable with no backups.

## Self-review notes

- Spec sections mapped: schema→T1, IP→T1, sweeper→T2, API→T3, sync gate→T3, deletion→T3, frontend+privacy page→T4, docs+verification→T5.
- Spec correction folded in: the sync gate covers three write sites, not one, and `purgeSynced` clears behavioural fields on manual rows.
- Known open item for the implementer of T3 Step 5: `sweepUser` must not honour `RETENTION_DRY_RUN` when called from the user-initiated purge. Flagged inline.
