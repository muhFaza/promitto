# Recent & Pinned Contacts — Design

Approved 2026-08-14 in-session. Adds a one-tap "recent contacts" quick-pick row to the
Dashboard compose section, with pinned contacts always first, ordered by real WhatsApp
interaction recency with a local scheduling-history fallback.

## Problem

Picking a recipient on the Dashboard requires typing into `ContactPicker` before any
option appears. Users message the same few people constantly; surfacing them removes
the search step entirely.

## Decisions (made with the owner)

1. **Recency source: hybrid.** Primary signal is WhatsApp itself (chat/message events
   from the live Baileys socket); fallback is the newest `scheduled_messages.created_at`
   per recipient, so the feature is useful from day one. WhatsApp only replays chat
   history at pair time, and the production session is already paired — WA-derived data
   accrues from live traffic, so the fallback matters.
2. **WA events consumed: chat events + live messages.** `messaging-history.set`,
   `chats.upsert`, `chats.update` (backfill on any future re-pair) plus
   `messages.upsert` (the signal that actually accrues on an already-paired session;
   fires for `fromMe` too, so the scheduler's own sends count).
3. **Placement: quick-pick chip row inside Compose**, directly above the
   `ContactPicker`. One tap fills the recipient. The picker's empty-search dropdown
   also shows the recent list.
4. **Pinning: toggle on `/app/contacts`.** Pinned contacts sort first everywhere
   (quick-pick row, picker default dropdown, contacts list). New nullable
   `contacts.pinned_at` column.

## Data model

One additive migration (0006), both columns nullable — the previous release must still
boot against this schema (no-backup box; rollback rolls the image, never the schema):

```sql
ALTER TABLE `contacts` ADD `pinned_at` integer;
ALTER TABLE `contacts` ADD `last_interaction_at` integer;
CREATE INDEX `contacts_user_recent_idx` ON `contacts` (`user_id`,`pinned_at`,`last_interaction_at`);
```

Both are `timestamp_ms` integers, matching every other timestamp in the schema.

## Capturing WhatsApp recency (`wa-sessions/manager.ts`)

Four listeners feed **one** per-user buffer, mirroring the existing
`handleContactsSync` debounce/cap pattern:

| Event | Extract |
|---|---|
| `messaging-history.set` | each `chats[].id` + `conversationTimestamp` (fallback `lastMessageRecvTimestamp`) |
| `chats.upsert` / `chats.update` | same (`ChatUpdate` may also carry `timestamp`) |
| `messages.upsert` | each `messages[].key.remoteJid` + `messageTimestamp`; both `notify` and `append` types; `fromMe` included |

- `Handle` gains `pendingInteractions: Map<jid, epochMs>` keeping the **max**
  timestamp per jid, plus its own debounce timer. Same 2 s quiet window and the same
  hard buffer cap as contact sync; flushed in one SQLite transaction.
- Baileys timestamps are `number | Long | null` in **seconds** — a normalizer converts
  Long via `Number(x.toString())` and multiplies values `< 1e12` by 1000.
- Only jids passing `isUserJid()` are kept (no groups, no `status@broadcast`, no
  `@lid`). Payload objects are read and dropped in the same tick; nothing but
  `(jid, number)` is retained — that is the memory-churn guard on a 195 MB heap.
- Flush **updates existing contacts only** (`last_interaction_at = max(old, new)`),
  never inserts. Chats arrive from unsaved numbers with no usable display name;
  contact creation stays with `contacts.upsert` as today.

## Recents query (`contacts/service.ts`)

`listRecent(userId, limit = 8)` (limit capped at 50):

- Pinned contacts first, ordered `pinned_at ASC` (stable pin order).
- Then unpinned, ordered `COALESCE(last_interaction_at, last_scheduled_at) DESC`,
  where `last_scheduled_at` is `MAX(created_at)` from that user's
  `scheduled_messages` grouped by `recipient_jid` (LEFT JOIN).
- Unpinned rows with no signal at all (no WA interaction, never scheduled to) are
  excluded. Pinned rows always appear.

`list()` (alphabetical listing) also sorts pinned-first so `/app/contacts` matches.

## API

- `GET /api/contacts/recent?limit=8` → `{ contacts: ContactPublic[] }`. Same router,
  inherits `requireAuth + requirePasswordRotated + requireCsrf`. No route collision
  (no `GET /:id` exists).
- `PATCH /api/contacts/:id` body becomes `{ displayName?: string, pinned?: boolean }`,
  zod-refined to require at least one key. `pinned: true` sets `pinned_at = now`
  only when currently null (repeat pin keeps stable order); `pinned: false` nulls it.
- `serializeContact` gains `pinnedAt: number | null` and
  `lastInteractionAt: number | null` (epoch-ms, per wire convention).

## Frontend

- `stores/contacts.ts` (currently an empty stub) becomes the shared owner of
  `recent: Contact[]`, `load()`, `togglePin(contact)` — pinning on `/app/contacts`
  updates the Dashboard without a manual refetch.
- New `components/ContactQuickPick.tsx`: wrapping row of hairline chips above the
  `ContactPicker` inside `ComposeScheduleForm`. Pinned chips carry a small `▪` in
  accent olive. Names in `font-sans` (a display name is prose, not machine data).
  One tap sets the recipient. **Hidden entirely when the list is empty** — a new
  user sees today's layout exactly. Semantics: `<ul>/<li>` with real `<button>`s,
  group labelled "Recent contacts".
- `ContactPicker`: when the search box is **empty**, the dropdown shows the recent
  list; falls back to the alphabetical list if recents are empty. Typing searches
  as today.
- `Contacts.tsx`: pin/unpin toggle per row; pinned rows surface first (server-side
  ordering) with the `▪` marker.
- After a schedule is created, the recent list is refreshed (the fallback ranking
  just changed).

## Out of scope

Group chats, media, per-chip pin gestures on the Dashboard, any "sync done" UI,
backfilling WA history via re-pair, frequency-weighted scoring.

## Verification

No test framework exists (deliberate). Verification is:

- `npm run typecheck` + `npm run lint` in both packages (via docker compose).
- `backend/scripts/test-interaction-flush.ts` — a non-interactive script in the
  existing `scripts/test-*` convention that drives `recordInteractions` +
  `listRecent` against a dev DB and asserts ordering/exclusion semantics.
- Exercising the dev stack in a browser: pin → chip order → one-tap compose.

The WA listeners cannot be exercised without a live pairing; their logic is confined
to extraction + the buffer, which the script covers at the service boundary.

## Risk

The migration is the only irreversible piece; it is additive and nullable, and Drizzle
emits explicit column lists, so the previous image runs unmodified against the new
schema. The WA listeners must never buffer message bodies — `(jid, ms)` only.
