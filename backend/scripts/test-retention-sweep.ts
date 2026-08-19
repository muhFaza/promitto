/**
 * Non-interactive check for the retention sweeper: exercises `sweepUser`
 * against a throwaway SQLite file so the dev DB is never touched. Usage:
 *   tsx scripts/test-retention-sweep.ts
 *
 * The whole run happens with RETENTION_DRY_RUN=true in the environment, so the
 * destructive assertions all pass `{ dryRun: false }` explicitly. That is
 * deliberate: it means every "this row is deleted" assertion doubles as proof
 * that an explicit `dryRun: false` overrides the operator flag, which is what
 * the user-initiated purge depends on.
 *
 * Exits non-zero on the first failed assertion; the temp DB is removed either way.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

// Must be set before ../src/db/client.js and ../src/config/env.js are loaded —
// both resolve their environment at import time. Hence the dynamic imports.
const dbPath = `./data/test-retention-sweep-${process.pid}.db`;
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET ||= 'test-retention-sweep-session-secret-0000';
process.env.LOG_LEVEL = 'silent';
process.env.RETENTION_DRY_RUN = 'true';

const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
const { eq } = await import('drizzle-orm');
const { db, sqlite } = await import('../src/db/client.js');
const { scheduledMessages, sentMessages, users } = await import('../src/db/schema.js');
const { env } = await import('../src/config/env.js');
const { sweepUser } = await import('../src/modules/privacy/retention.js');

migrate(db, { migrationsFolder: './drizzle' });

assert.equal(env.RETENTION_DRY_RUN, true, 'the fixture requires RETENTION_DRY_RUN=true');

const NOW = Date.now();
const DAY = 86_400_000;

const userId = randomUUID();
// A second tenant whose rows are just as expired as the first's. Nothing the
// first user's sweep does may touch them.
const otherUserId = randomUUID();

// Fixed ids so each assertion can name the exact row it cares about.
const SENT_OLD = 'sent-old';
const SENT_MID = 'sent-mid';
const SENT_NEW = 'sent-new';
const SCHED_DONE_ONCE_OLD = 'sched-done-once-old';
const SCHED_ACTIVE_ONCE_OLD = 'sched-active-once-old';
const SCHED_DONE_RECURRING_OLD = 'sched-done-recurring-old';
const SCHED_DONE_ONCE_NEW = 'sched-done-once-new';
const SENT_OLD_OTHER = 'sent-old-other';
const SCHED_DONE_ONCE_OLD_OTHER = 'sched-done-once-old-other';

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function seedUsers(): void {
  for (const [id, tag] of [
    [userId, 'retention-sweep'],
    [otherUserId, 'retention-sweep-other'],
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
}

function insertSent(id: string, owner: string, sentAtMs: number): void {
  db.insert(sentMessages)
    .values({
      id,
      scheduledMessageId: randomUUID(),
      userId: owner,
      recipientJid: '6281100000001@s.whatsapp.net',
      messageTextSnapshot: 'seed',
      status: 'sent',
      sentAt: new Date(sentAtMs),
    })
    .run();
}

function insertSched(
  id: string,
  owner: string,
  opts: {
    isActive: boolean;
    scheduleType: 'once' | 'recurring';
    updatedAtMs: number;
  },
): void {
  db.insert(scheduledMessages)
    .values({
      id,
      userId: owner,
      recipientJid: '6281100000001@s.whatsapp.net',
      recipientNameSnapshot: 'Alpha',
      messageText: 'seed',
      scheduleType: opts.scheduleType,
      cronExpression: opts.scheduleType === 'recurring' ? '0 9 * * *' : null,
      timezone: 'Asia/Jakarta',
      nextRunAt: new Date(NOW + DAY),
      isActive: opts.isActive,
      createdAt: new Date(opts.updatedAtMs),
      updatedAt: new Date(opts.updatedAtMs),
    })
    .run();
}

/** Wipe and re-seed the message tables so each phase starts from the same fixture. */
function reseedMessages(): void {
  db.delete(sentMessages).run();
  db.delete(scheduledMessages).run();

  insertSent(SENT_OLD, userId, NOW - 90 * DAY);
  insertSent(SENT_MID, userId, NOW - 20 * DAY);
  insertSent(SENT_NEW, userId, NOW - 1 * DAY);

  insertSched(SCHED_DONE_ONCE_OLD, userId, {
    isActive: false,
    scheduleType: 'once',
    updatedAtMs: NOW - 90 * DAY,
  });
  insertSched(SCHED_ACTIVE_ONCE_OLD, userId, {
    isActive: true,
    scheduleType: 'once',
    updatedAtMs: NOW - 90 * DAY,
  });
  insertSched(SCHED_DONE_RECURRING_OLD, userId, {
    isActive: false,
    scheduleType: 'recurring',
    updatedAtMs: NOW - 90 * DAY,
  });
  insertSched(SCHED_DONE_ONCE_NEW, userId, {
    isActive: false,
    scheduleType: 'once',
    updatedAtMs: NOW - 1 * DAY,
  });

  insertSent(SENT_OLD_OTHER, otherUserId, NOW - 90 * DAY);
  insertSched(SCHED_DONE_ONCE_OLD_OTHER, otherUserId, {
    isActive: false,
    scheduleType: 'once',
    updatedAtMs: NOW - 90 * DAY,
  });
}

function sentExists(id: string): boolean {
  return db.select({ id: sentMessages.id }).from(sentMessages).where(eq(sentMessages.id, id)).get() !== undefined;
}

function schedExists(id: string): boolean {
  return (
    db
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, id))
      .get() !== undefined
  );
}

function countFor(owner: string): { sent: number; sched: number } {
  return {
    sent: db.select({ id: sentMessages.id }).from(sentMessages).where(eq(sentMessages.userId, owner)).all()
      .length,
    sched: db
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(eq(scheduledMessages.userId, owner))
      .all().length,
  };
}

function run(): void {
  seedUsers();

  // ---- Phase A: a 60-day sweep of user 1, deleting for real. -------------
  reseedMessages();
  const a = sweepUser(userId, 60, { now: NOW, dryRun: false });

  // (1) Expired send history goes.
  assert.equal(sentExists(SENT_OLD), false, 'a 90-day-old sent_messages row should be deleted');
  assert.equal(a.sentMessages, 1, `expected 1 sent row deleted — got ${a.sentMessages}`);
  pass('(1) sent_messages older than the cutoff is deleted');

  // (2) Anything inside the window stays.
  assert.equal(sentExists(SENT_NEW), true, 'a 1-day-old sent_messages row must survive');
  assert.equal(sentExists(SENT_MID), true, 'a 20-day-old row must survive a 60-day retention');
  pass('(2) sent_messages newer than the cutoff survives');

  // (3) A finished one-off is history and expires.
  assert.equal(
    schedExists(SCHED_DONE_ONCE_OLD),
    false,
    'an inactive one-off older than the cutoff should be deleted',
  );
  pass('(3) inactive once schedule older than the cutoff is deleted');

  // (4) THE ONE THAT MATTERS: an active row is live configuration, not history.
  //     Age is irrelevant; deleting it would silently cancel a user's message.
  assert.equal(
    schedExists(SCHED_ACTIVE_ONCE_OLD),
    true,
    'an ACTIVE one-off must survive regardless of age',
  );
  pass('(4) active once schedule older than the cutoff survives');

  // (5) ALSO CRITICAL: recurring rows never expire, even when deactivated —
  //     the predicate must gate on schedule_type, not just is_active.
  assert.equal(
    schedExists(SCHED_DONE_RECURRING_OLD),
    true,
    'a recurring schedule must survive regardless of age or active state',
  );
  assert.equal(schedExists(SCHED_DONE_ONCE_NEW), true, 'a recent finished one-off must survive');
  // Counted last, after the survival checks above, so that widening the
  // predicate fails on the specific row it wrongly ate rather than on a bare
  // number that says nothing about which invariant broke.
  assert.equal(a.scheduledMessages, 1, `expected 1 schedule deleted — got ${a.scheduledMessages}`);
  pass('(5) inactive recurring schedule older than the cutoff survives');

  // (6) Tenancy: user 2's rows are equally expired and must be untouched.
  const other = countFor(otherUserId);
  assert.equal(other.sent, 1, "another user's sent history must be untouched");
  assert.equal(other.sched, 1, "another user's schedules must be untouched");
  assert.equal(sentExists(SENT_OLD_OTHER), true, "the other tenant's old sent row must survive");
  assert.equal(
    schedExists(SCHED_DONE_ONCE_OLD_OTHER),
    true,
    "the other tenant's old finished schedule must survive",
  );
  pass('(6) another user\'s expired rows are untouched by this user\'s sweep');

  // ---- Phase B: the same fixture at 7 days. ------------------------------
  reseedMessages();
  const b = sweepUser(userId, 7, { now: NOW, dryRun: false });

  // (7) SENT_MID survived at 60 (asserted above) and must not survive at 7.
  assert.equal(
    sentExists(SENT_MID),
    false,
    'a 20-day-old row that survived 60-day retention must be deleted at 7 days',
  );
  assert.equal(sentExists(SENT_NEW), true, 'a 1-day-old row must still survive 7-day retention');
  assert.equal(b.sentMessages, 2, `expected 2 sent rows deleted at 7 days — got ${b.sentMessages}`);
  assert.equal(schedExists(SCHED_DONE_ONCE_NEW), true, 'a 1-day-old finished one-off survives 7 days');
  pass('(7) shortening retentionDays from 60 to 7 changes which rows expire');

  // ---- Phase C: dry run, driven by the env flag. -------------------------
  reseedMessages();
  const before = countFor(userId);
  const c = sweepUser(userId, 60, { now: NOW });

  // (8) Counts are reported, nothing is deleted.
  assert.equal(c.sentMessages, 1, `dry run should report 1 sent row — got ${c.sentMessages}`);
  assert.equal(
    c.scheduledMessages,
    1,
    `dry run should report 1 schedule — got ${c.scheduledMessages}`,
  );
  assert.deepEqual(countFor(userId), before, 'a dry run must not delete anything');
  assert.equal(sentExists(SENT_OLD), true, 'the expired sent row must still exist after a dry run');
  assert.equal(
    schedExists(SCHED_DONE_ONCE_OLD),
    true,
    'the expired schedule must still exist after a dry run',
  );
  pass('(8) RETENTION_DRY_RUN=true reports counts and deletes nothing');

  // (9) The same call with an explicit dryRun:false deletes for real, from the
  //     same untouched state phase C left behind. This is what stands between a
  //     user clicking "delete my data" and a silent no-op.
  const d = sweepUser(userId, 60, { now: NOW, dryRun: false });
  assert.equal(d.sentMessages, 1, `explicit dryRun:false should delete 1 sent row — got ${d.sentMessages}`);
  assert.equal(
    d.scheduledMessages,
    1,
    `explicit dryRun:false should delete 1 schedule — got ${d.scheduledMessages}`,
  );
  assert.equal(sentExists(SENT_OLD), false, 'dryRun:false must delete despite RETENTION_DRY_RUN=true');
  assert.equal(
    schedExists(SCHED_DONE_ONCE_OLD),
    false,
    'dryRun:false must delete the expired schedule despite RETENTION_DRY_RUN=true',
  );
  assert.equal(schedExists(SCHED_ACTIVE_ONCE_OLD), true, 'the active row still survives a real purge');
  pass('(9) explicit dryRun:false overrides RETENTION_DRY_RUN=true');

  // ---- Phase D: the argument guard. --------------------------------------
  // A negative or non-finite retentionDays future-dates the cutoff, and a
  // future cutoff means "everything has expired" — the whole history, silently,
  // with no backups to restore from. The HTTP route validates, but sweepUser is
  // exported and destructive, so it validates for itself.
  reseedMessages();
  const before10 = countFor(userId);
  for (const bad of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, -0.0001]) {
    assert.throws(
      () => sweepUser(userId, bad, { now: NOW, dryRun: false }),
      /non-negative integer/,
      `sweepUser must refuse retentionDays=${String(bad)}`,
    );
  }
  assert.deepEqual(
    countFor(userId),
    before10,
    'a refused sweep must not have deleted anything',
  );
  pass('(10) sweepUser throws on a negative, NaN or fractional retentionDays');

  // (11) Zero is legal and is the one value that means "delete everything that
  //      has already happened" — the guard must not reject it, because the
  //      user-initiated purge passes exactly this.
  reseedMessages();
  const e = sweepUser(userId, 0, { now: NOW, dryRun: false });
  assert.equal(sentExists(SENT_OLD), false, 'retention 0 must delete the oldest sent row');
  assert.equal(sentExists(SENT_MID), false, 'retention 0 must delete the mid sent row');
  assert.equal(sentExists(SENT_NEW), false, 'retention 0 must delete even a 1-day-old sent row');
  assert.equal(e.sentMessages, 3, `retention 0 should delete all 3 sent rows — got ${e.sentMessages}`);
  assert.equal(
    schedExists(SCHED_DONE_ONCE_OLD),
    false,
    'retention 0 must delete a finished one-off',
  );
  assert.equal(
    schedExists(SCHED_DONE_ONCE_NEW),
    false,
    'retention 0 must delete a recent finished one-off',
  );
  assert.equal(
    e.scheduledMessages,
    2,
    `retention 0 should delete both finished one-offs — got ${e.scheduledMessages}`,
  );
  // Even a full purge leaves live configuration alone: the predicate, not the
  // cutoff, is what protects these.
  assert.equal(schedExists(SCHED_ACTIVE_ONCE_OLD), true, 'retention 0 must not cancel an active schedule');
  assert.equal(
    schedExists(SCHED_DONE_RECURRING_OLD),
    true,
    'retention 0 must not delete a recurring schedule',
  );
  assert.deepEqual(
    countFor(otherUserId),
    { sent: 1, sched: 1 },
    "retention 0 must stay scoped to one user",
  );
  pass('(11) retentionDays 0 deletes everything already past and nothing live');
}

const TOTAL = 11;

let failure: unknown = null;
try {
  run();
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
  console.error(`FAIL after ${passed}/${TOTAL} assertions`);
  process.exit(1);
}

console.log(`OK ${passed}/${TOTAL} assertions passed`);
process.exit(0);
