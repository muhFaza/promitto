/**
 * Non-interactive check for the recent contacts feature: exercises
 * `recordInteractions`, `recordPinStates` and `listRecent` against a throwaway
 * SQLite file so the dev DB is never touched. Usage:
 *   tsx scripts/test-interaction-flush.ts
 *
 * Exits non-zero on the first failed assertion; the temp DB is removed either way.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

// Must be set before ../src/db/client.js is loaded — it resolves DATABASE_PATH
// at import time. Hence the dynamic imports below.
const dbPath = `./data/test-interaction-flush-${process.pid}.db`;
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET ||= 'test-interaction-flush-session-secret-0000';
process.env.LOG_LEVEL = 'silent';

const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
const { db, sqlite } = await import('../src/db/client.js');
const { contacts, scheduledMessages, users } = await import('../src/db/schema.js');
const contactsService = await import('../src/modules/contacts/service.js');

migrate(db, { migrationsFolder: './drizzle' });

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const userId = randomUUID();
// A second tenant exists purely so the scheduling-fallback subquery inside
// listRecent is tested with something to leak: it schedules to a jid that is
// already a contact of user 1, so dropping the userId filter there would light
// up a contact that must stay dark.
const otherUserId = randomUUID();

type Seed = { id: string; name: string; jid: string; phone: string };

const alpha: Seed = {
  id: randomUUID(),
  name: 'Alpha',
  jid: '6281100000001@s.whatsapp.net',
  phone: '+6281100000001',
};
const bravo: Seed = {
  id: randomUUID(),
  name: 'Bravo',
  jid: '6281100000002@s.whatsapp.net',
  phone: '+6281100000002',
};
const charlie: Seed = {
  id: randomUUID(),
  name: 'Charlie',
  jid: '6281100000003@s.whatsapp.net',
  phone: '+6281100000003',
};
// No interaction and no schedule — its only route into the recents list is a
// WhatsApp pin, which is what makes it the interesting case in (f).
const delta: Seed = {
  id: randomUUID(),
  name: 'Delta',
  jid: '6281100000004@s.whatsapp.net',
  phone: '+6281100000004',
};

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function seed(): void {
  for (const [id, tag] of [
    [userId, 'interaction-flush'],
    [otherUserId, 'interaction-flush-other'],
  ] as const) {
    db.insert(users)
      .values({
        id,
        email: `${tag}-${process.pid}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'user',
        timezone: 'Asia/Jakarta',
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      })
      .run();
  }

  for (const c of [alpha, bravo, charlie, delta]) {
    db.insert(contacts)
      .values({
        id: c.id,
        userId,
        jid: c.jid,
        displayName: c.name,
        phone: c.phone,
        source: 'manual',
        verifiedOnWhatsapp: true,
        createdAt: new Date(NOW - DAY),
        updatedAt: new Date(NOW - DAY),
      })
      .run();
  }

  // Alpha: an old schedule, so its ordering must come from the WA interaction.
  // Bravo: a recent schedule and no WA interaction — the fallback signal.
  // Charlie and Delta: nothing at all until Delta gets pinned in (f).
  const schedules: Array<{ jid: string; name: string; createdAt: number }> = [
    { jid: alpha.jid, name: alpha.name, createdAt: NOW - 30 * DAY },
    { jid: bravo.jid, name: bravo.name, createdAt: NOW - 2 * HOUR },
  ];
  for (const s of schedules) {
    db.insert(scheduledMessages)
      .values({
        id: randomUUID(),
        userId,
        recipientJid: s.jid,
        recipientNameSnapshot: s.name,
        messageText: 'seed',
        scheduleType: 'once',
        timezone: 'Asia/Jakarta',
        nextRunAt: new Date(NOW + DAY),
        isActive: true,
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.createdAt),
      })
      .run();
  }

  // Cross-tenant bait: user 2 schedules to Charlie's jid one minute ago. Charlie
  // is user 1's contact and must stay excluded from user 1's recents; if the
  // subquery's userId filter were dropped, this would surface Charlie at the
  // top and assertions (c)/(e) would fail.
  db.insert(scheduledMessages)
    .values({
      id: randomUUID(),
      userId: otherUserId,
      recipientJid: charlie.jid,
      recipientNameSnapshot: charlie.name,
      messageText: 'other tenant',
      scheduleType: 'once',
      timezone: 'Asia/Jakarta',
      nextRunAt: new Date(NOW + DAY),
      isActive: true,
      createdAt: new Date(NOW - MINUTE),
      updatedAt: new Date(NOW - MINUTE),
    })
    .run();
}

function interactionAt(id: string): number | null {
  const row = contactsService.findById(userId, id);
  assert.ok(row, `contact ${id} should exist`);
  return row.lastInteractionAt?.getTime() ?? null;
}

function pinnedAt(id: string): number | null {
  const row = contactsService.findById(userId, id);
  assert.ok(row, `contact ${id} should exist`);
  return row.waPinnedAt?.getTime() ?? null;
}

function recentNames(): string[] {
  return contactsService.listRecent(userId, 8).map((c) => c.displayName);
}

async function run(): Promise<void> {
  seed();

  // Alpha's recency comes from the interaction buffer, not from its schedule.
  contactsService.recordInteractions(userId, new Map([[alpha.jid, NOW - HOUR]]));
  assert.equal(
    interactionAt(alpha.id),
    NOW - HOUR,
    'recordInteractions should stamp last_interaction_at',
  );

  const recent = contactsService.listRecent(userId, 8);
  const order = recent.map((c) => c.displayName);
  const idx = (name: string): number => order.indexOf(name);

  // (a) WA interaction (1h ago) outranks Bravo's scheduling fallback (2h ago),
  //     even though Alpha's own schedule is 30 days old.
  assert.ok(idx('Alpha') !== -1, 'Alpha should be listed');
  assert.ok(idx('Bravo') !== -1, 'Bravo should be listed');
  assert.ok(
    idx('Alpha') < idx('Bravo'),
    `Alpha should rank above Bravo — got ${JSON.stringify(order)}`,
  );
  pass('(a) WA interaction beats the scheduling fallback in ordering');

  // (b) Bravo has no WA interaction and still ranks, via its schedule, ahead of
  //     the never-touched Charlie (which does not rank at all).
  assert.equal(
    contactsService.findById(userId, bravo.id)?.lastInteractionAt ?? null,
    null,
    'Bravo should have no WA interaction',
  );
  assert.ok(
    idx('Bravo') !== -1 && idx('Charlie') === -1,
    `Bravo should outrank Charlie — got ${JSON.stringify(order)}`,
  );
  pass('(b) scheduling fallback ranks a scheduled-to contact above a never-touched one');

  // (c) Never-touched contacts are excluded entirely.
  assert.ok(
    !recent.some((c) => c.id === charlie.id),
    `Charlie should be excluded — got ${JSON.stringify(order)}`,
  );
  pass('(c) never-touched contact is excluded');

  // (d) A late-arriving older timestamp must not regress a newer one.
  contactsService.recordInteractions(userId, new Map([[alpha.jid, NOW - 5 * HOUR]]));
  assert.equal(
    interactionAt(alpha.id),
    NOW - HOUR,
    'a stale timestamp must not overwrite a newer last_interaction_at',
  );
  contactsService.recordInteractions(userId, new Map([[alpha.jid, NOW - MINUTE]]));
  assert.equal(
    interactionAt(alpha.id),
    NOW - MINUTE,
    'a newer timestamp should still advance last_interaction_at',
  );
  pass('(d) stale recordInteractions timestamp does not regress a newer value');

  // (e) Tenancy: user 2's schedule to Charlie's jid must not rank Charlie for
  //     user 1, and must not perturb user 1's ordering at all.
  const afterCrossTenant = contactsService
    .listRecent(userId, 8)
    .map((c) => c.displayName);
  assert.ok(
    !afterCrossTenant.includes('Charlie'),
    `another user's schedule must not surface Charlie — got ${JSON.stringify(afterCrossTenant)}`,
  );
  // Alpha advanced to NOW - MINUTE in (d); order is otherwise unchanged.
  assert.deepEqual(
    afterCrossTenant,
    order,
    `cross-tenant schedule must not reorder user 1's recents — got ${JSON.stringify(afterCrossTenant)}`,
  );
  // And the other tenant, who has no contacts of their own, gets nothing.
  assert.deepEqual(
    contactsService.listRecent(otherUserId, 8),
    [],
    'the other tenant has no contacts and must get an empty list',
  );
  pass('(e) scheduling fallback is scoped per user');

  // (f) A WhatsApp pin outranks every recency signal and the pinned block is
  //     ordered newest-pin-first (as WhatsApp orders it). Delta carries the
  //     proof: with no interaction and no schedule it has no way into this list
  //     at all except the pin, and it still lands above Bravo. Alpha leading is
  //     *not* evidence of anything here — it tops the list under recency too.
  contactsService.recordPinStates(
    userId,
    new Map([
      [delta.jid, NOW - 2 * DAY],
      [alpha.jid, NOW - HOUR],
    ]),
  );
  const pinned = recentNames();
  assert.deepEqual(
    pinned,
    ['Alpha', 'Delta', 'Bravo'],
    `WA-pinned rows should lead, newest pin first — got ${JSON.stringify(pinned)}`,
  );
  pass('(f) WA pin leads the list, newest-pin-first, and surfaces a signalless contact');

  // (g) An unpin arrives as an explicit null and must drop the row out of the
  //     pinned block — back to plain recency, where Alpha's NOW-MINUTE
  //     interaction still beats Bravo but no longer beats a pinned Delta.
  contactsService.recordPinStates(userId, new Map([[alpha.jid, null]]));
  assert.equal(pinnedAt(alpha.id), null, 'unpin should null wa_pinned_at');
  const unpinned = recentNames();
  assert.deepEqual(
    unpinned,
    ['Delta', 'Alpha', 'Bravo'],
    `unpinned Alpha should fall back to recency order — got ${JSON.stringify(unpinned)}`,
  );
  pass('(g) unpin removes the row from the pinned block');

  // (h) Re-pin Alpha with a stamp *newer* than Delta's, establishing a non-null
  //     starting value for (i). Writing onto the NULL left by (g) proves
  //     nothing about latest-wins on its own — a monotonic rule accepts any
  //     value over NULL — so this half only sets the trap.
  contactsService.recordPinStates(userId, new Map([[alpha.jid, NOW - HOUR]]));
  assert.equal(pinnedAt(alpha.id), NOW - HOUR, 'a re-pin should restore wa_pinned_at');
  const rePinnedNewer = recentNames();
  assert.deepEqual(
    rePinnedNewer,
    ['Alpha', 'Delta', 'Bravo'],
    `Alpha's newer pin should lead the pinned block — got ${JSON.stringify(rePinnedNewer)}`,
  );
  pass('(h) re-pin restores the row to the pinned block, newest pin first');

  // (i) Pin state is latest-wins, NOT monotonic: overwriting the NOW-HOUR pin
  //     set in (h) with a far older stamp must move wa_pinned_at *backwards* to
  //     exactly that value, and must sort Alpha back below Delta. A max-based
  //     rule (which is correct for last_interaction_at) would leave both the
  //     column and the order untouched, so this is the assertion that separates
  //     the two.
  contactsService.recordPinStates(userId, new Map([[alpha.jid, NOW - 10 * DAY]]));
  assert.equal(
    pinnedAt(alpha.id),
    NOW - 10 * DAY,
    'an older pin timestamp must overwrite a newer one — pin state is not monotonic',
  );
  const repinned = recentNames();
  assert.deepEqual(
    repinned,
    ['Delta', 'Alpha', 'Bravo'],
    `re-pinned Alpha should sort below the newer-pinned Delta — got ${JSON.stringify(repinned)}`,
  );
  assert.equal(
    pinnedAt(delta.id),
    NOW - 2 * DAY,
    "Delta's pin must be untouched by Alpha's update",
  );
  pass('(i) pin state is latest-wins, not monotonic');
}

let failure: unknown = null;
try {
  await run();
} catch (err) {
  failure = err;
} finally {
  sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  console.error(`FAIL after ${passed}/9 assertions`);
  process.exit(1);
}

console.log(`OK ${passed}/9 assertions passed`);
process.exit(0);
