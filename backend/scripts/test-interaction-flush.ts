/**
 * Non-interactive check for the recent/pinned contacts feature: exercises
 * `recordInteractions`, `listRecent` and `setPinned` against a throwaway SQLite
 * file so the dev DB is never touched. Usage:
 *   tsx scripts/test-interaction-flush.ts
 *
 * Exits non-zero on the first failed assertion; the temp DB is removed either way.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

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
  db.insert(users)
    .values({
      id: userId,
      email: `interaction-flush-${process.pid}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'user',
      timezone: 'Asia/Jakarta',
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run();

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
  // Charlie: nothing at all. Delta: pinned only.
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
}

function interactionAt(id: string): number | null {
  const row = contactsService.findById(userId, id);
  assert.ok(row, `contact ${id} should exist`);
  return row.lastInteractionAt?.getTime() ?? null;
}

async function run(): Promise<void> {
  seed();

  // Pin Delta, then re-pin later to prove the timestamp is not restamped.
  const firstPin = contactsService.setPinned(userId, delta.id, true);
  assert.ok(firstPin?.pinnedAt, 'Delta should be pinned');
  const firstPinnedAt = firstPin.pinnedAt.getTime();

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

  // (c) Never-touched, unpinned contacts are excluded entirely.
  assert.ok(
    !recent.some((c) => c.id === charlie.id),
    `Charlie should be excluded — got ${JSON.stringify(order)}`,
  );
  pass('(c) never-touched unpinned contact is excluded');

  // (d) Pinned wins over every recency signal.
  assert.equal(
    order[0],
    'Delta',
    `pinned Delta should be first — got ${JSON.stringify(order)}`,
  );
  pass('(d) pinned-but-never-touched contact appears first');

  // (e) A late-arriving older timestamp must not regress a newer one.
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
  pass('(e) stale recordInteractions timestamp does not regress a newer value');

  // (f) Re-pinning keeps the original pinned_at, so the pinned block does not
  //     reshuffle under the caller.
  await sleep(15);
  const secondPin = contactsService.setPinned(userId, delta.id, true);
  assert.equal(
    secondPin?.pinnedAt?.getTime(),
    firstPinnedAt,
    'repeat pin must not restamp pinned_at',
  );
  pass('(f) repeat pin keeps the original pinnedAt');
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
  console.error(`FAIL after ${passed}/6 assertions`);
  process.exit(1);
}

console.log(`OK ${passed}/6 assertions passed`);
process.exit(0);
