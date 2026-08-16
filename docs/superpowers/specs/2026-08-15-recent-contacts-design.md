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

## Amendment (2026-08-15)

Decided by the owner after seeing the branch previewed; the branch was unmerged and
undeployed, so the changes were made in place rather than layered on top.

**App-local pinning is replaced by a read-only mirror of WhatsApp's real pins.**
Decision 4 above, the `contacts.pinned_at` column, `setPinned` / `applyPatch`, the
`pinned` key on `PATCH /:id`, and `ContactPublic.pinnedAt` are all gone. The reason is
naming, not mechanics: WhatsApp already has pinned chats, and a second, app-local pin
that does not correspond to them reads as a bug. So instead of inventing a parallel
concept, the real one is mirrored.

- New nullable `contacts.wa_pinned_at`. Nothing in the API writes it — there is no pin
  endpoint and no pin control in the UI. The only writer is `recordPinStates()`, fed
  from WhatsApp.
- Captured from the three **chat-shaped** events already being consumed
  (`messaging-history.set`, `chats.upsert`, `chats.update`); `messages.upsert` carries
  no pin information. `pinned` is read by own-key presence
  (`Object.prototype.hasOwnProperty.call(c, 'pinned')`) — an absent key means the event
  says nothing about pinning and must leave the row alone, while a present-but-falsy
  value is a genuine unpin. `hasOwnProperty` rather than `in` because decoded
  `proto.Conversation` instances inherit `pinned = null` from their prototype, which
  makes `in` true for every chat in a history replay. The real inbound shape is
  `proto.IConversation.pinned`, `number|null` in seconds; `pinToMs()` also accepts a
  boolean (stamped with arrival time) purely defensively — rc14's boolean pin site in
  `Utils/chat-utils` constructs an outbound patch and never reaches us.
- Buffered in a second per-handle map, `pendingPins`, sharing the interaction buffer's
  debounce, cap, flush (`flushPendingRecency`) and teardown. It is **latest-wins, not
  max**: pin state is a fact being mirrored, and a max rule cannot express an unpin.
  `recordPinStates()` is correspondingly non-monotonic, unlike `recordInteractions()`.
- `listRecent()` orders `wa_pinned_at IS NOT NULL` first, `wa_pinned_at DESC` within
  that block (newest pin first, as WhatsApp orders it), then
  `COALESCE(last_interaction_at, last_scheduled_at) DESC`. A WA-pinned contact always
  appears, even with no other signal. `list()` stays plain alphabetical.

**Accrual caveat.** WhatsApp's app-state sync delivers pin *changes*, not the historical
set, so on the already-paired production session the pins that exist today will not
appear until each is unpinned and re-pinned on the phone. Future pin/unpin actions
arrive live. This is the same shape as the interaction-recency caveat in decision 1, and
there is no fallback for it — an empty pinned block is the expected initial state.

## Amendment (2026-08-17) — LID addressing

Shipped as a bugfix against the merged feature. On the production account the pinned
block stayed empty past the accrual caveat above: a real re-pin still never reached
`wa_pinned_at`.

The account is **LID-migrated** (~9k `lid-mapping` entries in its auth state), so
WhatsApp addresses many chats as `<n>@lid` rather than `<phone>@s.whatsapp.net`. Both
capture paths applied `isUserJid()` — which only accepts the phone form — *before* any
translation, so every LID-addressed event was silently discarded. Pins were hit hardest:
the pin sync emits a bare `{ id, pinned, conditional }` (`chat-utils.js:737-744`) with no
phone form attached, so there was nothing to fall back to.

- Every jid on the recency/pin path is now normalized to its phone form **before** the
  `isUserJid()` gate, which stays as the final gate. Synchronous where the event carries
  a phone twin — `key.remoteJidAlt` on messages and `proto.IConversation.pnJid` on chats,
  the latter read by truthiness since protobufjs's prototype default is `null`
  (`WAProto/index.js:24067`) and absent/null/empty all mean "no PN form".
- **`remoteJidAlt` is only trusted on inbound messages.** It is the PN twin of the
  *sender*, not of the chat: `extractAddressingContext` derives it from
  `participant || from`, and `decode-wa-message.js:180` attaches it to the key for any
  non-group chat regardless of direction. Inbound, the sender *is* the counterpart, so it
  is exactly right. On a `fromMe` message synced from the phone the sender is us while
  `remoteJid` is the counterpart's LID — trusting it there would file the interaction
  under the user's own number and lose it for the real contact. The decoder computes the
  correct value for that case (`recipientAlt`, from `recipient_pn`) but discards it, so
  outbound LID chats have no synchronous answer and take the queue.
- Otherwise the handler extracts primitives only — `{ lid, ms, pin }`, no chat or message
  object retained — onto a per-handle FIFO, drained by
  `signalRepository.lidMapping.getPNsForLIDs()` (a local auth-state read, not a network
  call) and replayed into the same `pendingInteractions` / `pendingPins` buffers.
- One queue with a single non-reentrant drain, not a promise per event: `pendingPins` is
  latest-wins, so out-of-order resolution could replay a pin *after* the unpin that
  followed it and leave the row pinned. That ordering only covers what goes *through* the
  queue, so an already-resolved **pin** is also queued (flagged `resolved`, so the drain
  skips the store lookup for it) whenever the queue is non-empty or draining — otherwise
  a PN-addressed pin written inline would land ahead of an older LID entry for the same
  chat resolving a microtask later. Interactions keep the inline fast path: they are a
  high-water mark, so an out-of-order replay is a no-op rather than a wrong value.
- `getPNsForLIDs` answers `<user>:<device>@s.whatsapp.net`; the device suffix is stripped
  with `jidNormalizedUser` or the result would fail `isUserJid` for the same reason the
  lid did.
- No local lid→pn cache. `LIDMappingStore` already fronts the auth state with an LRU
  (3-day TTL, `updateAgeOnGet`) and coalesces concurrent lookups; a second cache would
  cost heap on a 195MB budget and could outlive a re-pair that changed the mapping.
- The drain drops its batch if the socket is gone, the manager is stopping, or the handle
  is tearing down, so a late resolution cannot arm a debounce timer behind
  `flushPendingRecency()` at teardown. The `tearingDown` flag is needed on top of the
  socket check because `disconnect()` nulls `h.sock` only *after* `await sock.end()` — a
  drain waking inside that await would otherwise pass the check and write behind the
  final flush. It is cleared in `runOpenSocket`, the one choke point every open path
  shares (the reconnect timer and the supervisor both bypass `connect()`).
- Hosted-LID (`@hosted.lid`) is knowingly out of scope: `isLidUser` does not match it and
  `getPNsForLIDs` skips it, so such a jid still dies at the gate.

The `contacts.upsert`/`update` path needed no change: it already prefers `c.phoneNumber`
over `c.id`, which is the phone form for a LID contact.

Migration 0006 was regenerated rather than amended (twice — once to drop `pinned_at`,
once to add `wa_pinned_at`), so the branch still ships exactly one migration. It now
emits `last_interaction_at` + `wa_pinned_at` + `contacts_user_recent_idx (user_id,
last_interaction_at)`. The index deliberately does not cover `wa_pinned_at`: the pinned
block is a handful of rows out of a per-user contact list, and the sort is already
bounded by the same `LIMIT`.

**Avatars are added.** Recent rows show the contact's WhatsApp profile picture.
`GET /api/contacts/:id/avatar` looks the contact up user-scoped, asks
`sessionManager.getAvatarUrl()`, and 302s to the WA CDN URL — the image is never
fetched or proxied through this process, so nothing is buffered on a 195 MB heap.
`getAvatarUrl()` returns null (never throws) when the session is not connected, when
the contact hides their picture, and on any error; results are cached per handle for
6h on a hit and 10min on a miss, so a disconnected session costs one lookup per contact
per 10 minutes rather than one per render. The cache is cleared alongside the
credentials on logout. 404 `avatar` is the no-picture answer, and it is routine.

**Quick-pick is restyled from chips to rows** to carry the avatar and the phone number
(frontend change).

## Amendment (2026-08-17) — pin icon, pagination

Both owner decisions, taken on the merged feature.

**The `▪` marker is replaced by WhatsApp's own pin glyph.** A Material Symbols `push_pin`
path is inlined in `ContactQuickPick.tsx` (no icon package for one glyph) and rotated
`-45deg` at the call site: the path is drawn upright, and upright at 12px it reads as a
generic marker rather than a pin — the tilt is what makes it WhatsApp's. It renders in
`text-ink-muted`, **not** the accent olive the original spec called for. Owner call: a
mirrored pin is a neutral marker, and accent is reserved for live/success status. The
`sr-only` "Pinned on WhatsApp:" prefix carries the meaning for screen readers.

**The list pages instead of showing one fixed page.** Six rows initially, +6 per press of
"Show more ↓", ceiling `RECENT_MAX = 48` (the endpoint itself rejects `limit > 50`). Each
press refetches at the larger limit rather than appending — `listRecent` is one bounded
query and the ordering can change between presses, so a re-read is both simpler and more
correct than stitching pages. `hasMore` is a **heuristic**: the endpoint returns rows and
no total, so `returned === limit` (below the ceiling) is the only "more exist" signal
available, and it can be one press late when the count lands exactly on a page boundary.
Accepted. `limit` lives in the store so an expanded list survives the refetch after a send;
`reset()` restores 6.

**No internal scroll container** (owner decision). The rows simply grow down the page, and
"Show more ↓" sits below them continuing the hairline rhythm. A nested scroll region inside
a compose form is worse than a longer page.
