# Recent & Pinned Contacts Implementation Plan

> **Superseded.** Executed, then substantially revised before merge. App-local pinning
> (this plan's `pinned_at`, `setPinned`, `PATCH {pinned}`, Task 6) never shipped. See the
> spec's Amendment sections for what actually landed.

> **For agentic workers:** Execute your assigned task(s) only. Steps use checkbox
> (`- [ ]`) syntax. **This repo does NOT use TDD** (owner rule) and has **no test
> framework** — verification is `typecheck` + `lint` + the script in Task 7.
> **Do NOT commit** — the orchestrator commits at task boundaries.

**Goal:** One-tap recent-contacts quick-pick on the Dashboard compose form, pinned
contacts first, ordered by WhatsApp interaction recency with a scheduling-history
fallback. Spec: `docs/superpowers/specs/2026-08-15-recent-contacts-design.md` (read it first).

**Architecture:** Two nullable columns on `contacts` (`pinned_at`,
`last_interaction_at`); four Baileys listeners feed a debounced `(jid, ms)` buffer
flushed into `last_interaction_at`; `GET /api/contacts/recent` serves
pinned-then-recent; a Zustand store shares the list between the Dashboard chips,
the picker's default dropdown, and the Contacts page pin toggles.

**Tech Stack:** Express + zod + Drizzle/better-sqlite3 (sync), Baileys 7.0.0-rc14,
React 18 + Zustand v5 (curried `create<T>()()` form), Tailwind design tokens.

## Global Constraints

- Worktree: `/Users/faza/repos/personal/worktrees/promitto-feat-recent-contacts` — work ONLY here.
- Migration must be **additive + nullable** — previous release must boot on the new schema.
- Never return a raw DB row — always `serializeContact`. Timestamps on the wire are **epoch-ms numbers or null**.
- WA buffer retains `(jid: string, ms: number)` ONLY — never message/chat objects (195 MB heap box).
- Design tokens only (`paper/ink/rule/accent/accent-warm`); mono is for machine data only; no new deps.
- Baileys timestamps arrive in **seconds** as `number | Long | null` — normalize via `Number(x.toString())`, `× 1000` when `< 1e12`.
- Drizzle 0.36 index API: return a plain object from the table callback.
- Zod refinements must produce a 400 through the existing `errorMiddleware` (throw the bare ZodError).

---

### Task 1: Schema + migration 0006

**Files:**
- Modify: `backend/src/db/schema.ts` (contacts table, ~lines 76–99)
- Create: `backend/drizzle/0006_<slug>.sql` + `backend/drizzle/meta/0006_snapshot.json` + journal entry

**Interfaces:**
- Produces: `contacts.pinnedAt`, `contacts.lastInteractionAt` (`timestamp_ms`, nullable) on the Drizzle schema; `Contact` inferred type picks them up automatically.

- [ ] **Step 1: Add columns + index to `schema.ts`**

In the `contacts` table, after `verifiedOnWhatsapp`:

```ts
    pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }),
    lastInteractionAt: integer('last_interaction_at', { mode: 'timestamp_ms' }),
```

And in the index callback object:

```ts
    userRecentIdx: index('contacts_user_recent_idx').on(t.userId, t.pinnedAt, t.lastInteractionAt),
```

- [ ] **Step 2: Generate the migration with drizzle-kit**

Preferred: `cp backend/.env.example backend/.env` (worktree copy) then
`docker compose run --rm backend npm run db:generate` (fresh compose project in the
worktree builds the dev image + installs deps into a fresh volume — slow once, fine).
Fallback if docker generation is impractical: hand-write
`backend/drizzle/0006_recent_contacts.sql`:

```sql
ALTER TABLE `contacts` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_interaction_at` integer;--> statement-breakpoint
CREATE INDEX `contacts_user_recent_idx` ON `contacts` (`user_id`,`pinned_at`,`last_interaction_at`);
```

plus append `{ "idx": 6, "version": "6", "when": <epoch-ms>, "tag": "0006_recent_contacts", "breakpoints": true }`
to `backend/drizzle/meta/_journal.json`, and create `meta/0006_snapshot.json` by
copying `0005_snapshot.json` and adding the two columns (`"notNull": false,
"autoincrement": false`) and the index to the `contacts` entry, updating `id`/
`prevId` fields to match the journal chain convention visible in 0004→0005.
The snapshot must be right or the *next* `db:generate` re-emits these columns.

- [ ] **Step 3: Verify migration applies**

`docker compose run --rm backend npm run db:migrate` against a scratch dev DB, then
confirm `PRAGMA table_info(contacts)` shows both columns.

---

### Task 2: Contacts service, routes, serializer

**Files:**
- Modify: `backend/src/modules/contacts/service.ts`, `backend/src/modules/contacts/routes.ts`, `backend/src/lib/contact.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `service.listRecent(userId: string, limit?: number): Contact[]`
  - `service.setPinned(userId: string, id: string, pinned: boolean): Contact | null`
  - `service.recordInteractions(userId: string, interactions: ReadonlyMap<string, number>): void` (jid → epoch-ms; **UPDATE-only**, one transaction)
  - `GET /api/contacts/recent?limit=` → `{ contacts: ContactPublic[] }`
  - `PATCH /api/contacts/:id` accepts `{ displayName?, pinned? }` (≥1 key)
  - `ContactPublic` gains `pinnedAt: number | null`, `lastInteractionAt: number | null`

- [ ] **Step 1: `listRecent`** — pinned first (`pinned_at ASC`), then unpinned by
`COALESCE(last_interaction_at, last_scheduled_at) DESC`; unpinned rows with neither
signal are excluded; default limit 8, cap 50. Left-join a
`MAX(created_at) … GROUP BY recipient_jid` subquery on `scheduled_messages`
(match on `contacts.jid`, scoped to the same user in the subquery's WHERE).
Use Drizzle's query builder with `sql`-fragment ordering, e.g.:

```ts
const lastScheduled = db
  .select({
    recipientJid: scheduledMessages.recipientJid,
    lastScheduledAt: sql<number>`max(${scheduledMessages.createdAt})`.as('last_scheduled_at'),
  })
  .from(scheduledMessages)
  .where(eq(scheduledMessages.userId, userId))
  .groupBy(scheduledMessages.recipientJid)
  .as('ls');
// select().from(contacts).leftJoin(lastScheduled, eq(contacts.jid, lastScheduled.recipientJid))
// WHERE user match AND (pinned_at IS NOT NULL OR last_interaction_at IS NOT NULL OR ls.last_scheduled_at IS NOT NULL)
// ORDER BY (pinned_at IS NULL) ASC, pinned_at ASC, COALESCE(last_interaction_at, ls.last_scheduled_at) DESC
```

Return `Contact[]` (strip the join column before returning, or select `contacts`
columns explicitly).

- [ ] **Step 2: `setPinned`** — `pinned: true` sets `pinnedAt = new Date()` **only
if currently null** (repeat pin must not reshuffle order); `false` sets null. Return
`findById` afterwards.

- [ ] **Step 3: `recordInteractions`** — one immediate transaction; per entry:

```sql
UPDATE contacts SET last_interaction_at = :ts, updated_at = :now
WHERE user_id = :u AND jid = :jid
  AND (last_interaction_at IS NULL OR last_interaction_at < :ts)
```

UPDATE-only (never insert). Use `sqlite.transaction(...)` / drizzle equivalent
consistent with how `auth/service.ts` batches.

- [ ] **Step 4: Pinned-first in `list()`** — change both branches' `orderBy` to
pinned-first (`sql`(${contacts.pinnedAt} IS NULL)``, then `asc(contacts.pinnedAt)`), then `asc(contacts.displayName)`.

- [ ] **Step 5: Routes** — `GET /recent` with `z.object({ limit: z.coerce.number().int().min(1).max(50).optional() })`;
extend `UpdateBody` to `{ displayName?: min1 max120, pinned?: boolean }` with
`.refine((b) => b.displayName !== undefined || b.pinned !== undefined)`; PATCH applies
rename and/or pin, 404 via existing `findById` check, returns serialized result.

- [ ] **Step 6: Serializer** — add `pinnedAt: c.pinnedAt?.getTime() ?? null`,
`lastInteractionAt: c.lastInteractionAt?.getTime() ?? null` to `ContactPublic` + `serializeContact`.

---

### Task 3: Baileys interaction listeners (`manager.ts`)

**Files:**
- Modify: `backend/src/modules/wa-sessions/manager.ts`; constants file where `CONTACT_SYNC_DEBOUNCE_MS` / `CONTACT_SYNC_MAX_BUFFER` live (follow it).

**Interfaces:**
- Consumes: `contactsService.recordInteractions(userId, Map<jid, ms>)` from Task 2.
- Produces: nothing new externally; `Handle` gains private buffer state.

- [ ] **Step 1: Timestamp normalizer** (module-scope helper in `manager.ts`):

```ts
type WaTs = number | Long | bigint | null | undefined;
function waTsToMs(ts: WaTs): number | null {
  if (ts == null) return null;
  const n = typeof ts === 'number' ? ts : Number(ts.toString());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
```

(Import the `Long` type the way the installed baileys exposes it, or type the
param structurally `{ toString(): string }` if the import is awkward.)

- [ ] **Step 2: Buffer on `Handle`** — `pendingInteractions: Map<string, number>`
+ `interactionDebounceTimer`, initialized/cleared exactly where `pendingContacts` /
`syncDebounceTimer` are (creation, dispose/close, shutdown). Mirror the existing
lifecycle precisely — if contact-sync state is dropped on socket dispose, drop this
too; if flushed, flush.

- [ ] **Step 3: `recordInteraction(h, jid, ms)`** — skip unless `isUserJid(jid)`
(this already excludes groups/`@lid`/`status@broadcast`); keep
`max(existing, ms)`; on buffer size ≥ the same hard cap as contact sync, flush
immediately; else (re)start the same debounce window. Flush =
`contactsService.recordInteractions(h.userId, map)` in try/catch (log warn on
failure, never throw into a Baileys handler), then clear the map.

- [ ] **Step 4: Wire four listeners** next to the existing `contacts.upsert` pair:

```ts
sock.ev.on('messaging-history.set', ({ chats }) => {
  for (const c of chats) {
    const ms = waTsToMs(c.conversationTimestamp) ?? waTsToMs(c.lastMessageRecvTimestamp);
    if (c.id && ms) this.recordInteraction(h, c.id, ms);
  }
});
sock.ev.on('chats.upsert', (cs) => { /* same extraction */ });
sock.ev.on('chats.update', (cs) => { /* same, ChatUpdate.timestamp as extra fallback */ });
sock.ev.on('messages.upsert', ({ messages }) => {
  for (const m of messages) {
    const jid = m.key?.remoteJid;
    const ms = waTsToMs(m.messageTimestamp);
    if (jid && ms) this.recordInteraction(h, jid, ms);
  }
});
```

Handlers must be synchronous extraction only — no awaits, no retained references to
`chats`/`messages` after the loop.

---

### Task 4: Frontend types, API, store

**Files:**
- Modify: `frontend/src/lib/types.ts`, `frontend/src/api/contacts.ts`, `frontend/src/stores/contacts.ts`

**Interfaces:**
- Consumes: Task 2 wire shapes.
- Produces:
  - `Contact` type += `pinnedAt: number | null; lastInteractionAt: number | null`
  - `contactsApi.recent(limit?: number): Promise<{ contacts: Contact[] }>`
  - `contactsApi.setPinned(id: string, pinned: boolean): Promise<Contact>` (PATCH)
  - `useContactsStore`: `{ recent: Contact[]; loaded: boolean; load(): Promise<void>; togglePin(c: Contact): Promise<void> }`

- [ ] **Step 1: types + api** — mirror Task 2 exactly; `recent` hits
`/api/contacts/recent`, `setPinned` PATCHes `{ pinned }`.

- [ ] **Step 2: store** (replace the stub; keep the curried v5 form):

```ts
export const useContactsStore = create<ContactsState>()((set, get) => ({
  recent: [],
  loaded: false,
  load: async () => {
    try {
      const r = await contactsApi.recent(8);
      set({ recent: r.contacts, loaded: true });
    } catch { set({ loaded: true }); }
  },
  togglePin: async (c) => {
    await contactsApi.setPinned(c.id, !c.pinnedAt); // let ApiError propagate to caller
    await get().load();
  },
}));
```

---

### Task 5: ContactQuickPick + picker default + compose wiring

**Files:**
- Create: `frontend/src/components/ContactQuickPick.tsx`
- Modify: `frontend/src/components/ContactPicker.tsx`, `frontend/src/components/ComposeScheduleForm.tsx`

**Interfaces:**
- Consumes: store from Task 4; `ContactPicker`'s existing `value/onChange` props.
- Produces: `<ContactQuickPick onSelect={(c: Contact) => void} selectedJid={string | null} />`

- [ ] **Step 1: `ContactQuickPick`** — on mount `load()` if `!loaded`. Render
`null` when `recent.length === 0`. Otherwise an eyebrow label "Recent" and a
wrapping `<ul>` (`flex flex-wrap gap-2`, `aria-label="Recent contacts"`) of
`<li><button>` chips: `rounded-sm border border-rule bg-paper-raised px-3 py-1.5
text-sm text-ink transition-colors hover:bg-paper-deep`; selected chip
(`selectedJid === c.jid`) swaps to `border-ink`; pinned chips prefix
`<span aria-hidden className="text-accent">▪</span>` plus `sr-only` "pinned".
Names in the default sans face — no mono.

- [ ] **Step 2: Compose wiring** — read `ComposeScheduleForm.tsx`, find where the
recipient `Contact` state lives, and render the quick-pick immediately above the
`ContactPicker`, `onSelect` setting that same state (tapping a chip while one is
selected replaces the selection). After a successful create, call
`useContactsStore.getState().load()` (the fallback ranking just changed).

- [ ] **Step 3: Picker default dropdown** — in `ContactPicker.query('')` (empty
input), fetch `contactsApi.recent(20)` and use its contacts when non-empty,
falling back to `contactsApi.list({ limit: 20 })` when empty. Non-empty input
behaves exactly as today. Show pinned `▪` in the dropdown rows too.

---

### Task 6: Contacts page pin toggle

**Files:**
- Modify: `frontend/src/pages/Contacts.tsx`

**Interfaces:**
- Consumes: `useContactsStore.togglePin`, `Contact.pinnedAt`, server-side pinned-first ordering from Task 2 Step 4.

- [ ] **Step 1** — read the page, add a per-row pin control (text-button in the
existing row-action style: "Pin" / "Unpin", `eyebrow`-class like other row
actions): `await togglePin(c)` then refresh the page's own list so the row jumps
to the pinned block; surface `ApiError` through the page's existing error/toast
pattern. Pinned rows show the `▪` accent marker beside the name.

---

### Task 7: Verification script + full check

**Files:**
- Create: `backend/scripts/test-interaction-flush.ts` (convention: existing `scripts/test-*.ts` non-interactive helpers, run via `tsx`)

**Interfaces:**
- Consumes: Tasks 1–2 (`recordInteractions`, `listRecent`, `setPinned`).

- [ ] **Step 1: Script** — point `DATABASE_PATH`-equivalent env (check
`config/env.ts` for the actual var) at a temp SQLite file, run migrations, seed one
user + 4 contacts + 1 scheduled message, then assert with plain `assert`:
(a) WA interaction beats scheduling fallback in ordering; (b) fallback ranks a
scheduled-to contact above a never-touched one; (c) never-touched unpinned contact
is excluded; (d) pinned-but-never-touched contact appears first; (e) stale
`recordInteractions` timestamp does not regress a newer value; (f) repeat pin keeps
the original `pinnedAt`. Exit non-zero on failure, print PASS lines.

- [ ] **Step 2: Run everything**

```bash
docker compose run --rm backend npm run typecheck
docker compose run --rm backend npm run lint
docker compose run --rm backend npx tsx scripts/test-interaction-flush.ts
docker compose run --rm frontend npm run typecheck
docker compose run --rm frontend npm run lint
```

All must pass; report exact failures otherwise.

---

### Task 8 (orchestrator): docs, review, PR

- [ ] Update `CLAUDE.md` (repo root): contacts router line (add `recent`, pin via
PATCH), data model note for the two columns, one line on the interaction listeners.
- [ ] Code review (fresh reviewer agent), fix findings.
- [ ] Browser pass on the dev stack (seeded data): chips render, pin reorders, tap fills recipient.
- [ ] Commit(s), push `feat/recent-contacts`, open PR to `main`. **Do not merge.**
