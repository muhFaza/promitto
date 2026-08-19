/**
 * Non-interactive check for the last-superuser guard: exercises
 * `countSuperusers` and `deleteSelf` against a throwaway SQLite file so the dev
 * DB is never touched. Usage:
 *   tsx scripts/test-superuser-guard.ts
 *
 * The case that matters is the disabled one. A disabled superuser is rejected by
 * `requireAuth` and cannot re-enable themselves, so counting them would let
 * superuser A disable superuser B and then delete themselves — leaving an
 * instance with no usable superuser and no signup path to recover.
 *
 * Exits non-zero on the first failed assertion; the temp DB is removed either way.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

// Must be set before ../src/db/client.js is loaded — it resolves DATABASE_PATH
// at import time. Hence the dynamic imports below.
const dbPath = `./data/test-superuser-guard-${process.pid}.db`;
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET ||= 'test-superuser-guard-session-secret-0000';
process.env.LOG_LEVEL = 'silent';

const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
const { db, sqlite } = await import('../src/db/client.js');
const { users } = await import('../src/db/schema.js');
const usersService = await import('../src/modules/users/service.js');

migrate(db, { migrationsFolder: './drizzle' });

const NOW = Date.now();

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function seed(tag: string, role: 'user' | 'superuser', disabled: boolean): string {
  const id = randomUUID();
  db.insert(users)
    .values({
      id,
      email: `${tag}-${process.pid}@example.test`,
      passwordHash: 'not-a-real-hash',
      role,
      timezone: 'Asia/Jakarta',
      disabledAt: disabled ? new Date(NOW) : null,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run();
  return id;
}

function run(): void {
  const { countSuperusers, deleteSelf, setDisabledAt } = usersService;

  // (a) baseline: one enabled superuser, one plain user.
  const alpha = seed('alpha', 'superuser', false);
  seed('plain', 'user', false);
  assert.equal(countSuperusers(), 1, 'a plain user must not count as a superuser');
  assert.equal(
    deleteSelf(alpha),
    'last_superuser',
    'the only superuser must not be able to delete themselves',
  );
  pass('(a) lone superuser is refused');

  // (b) a second *enabled* superuser unblocks the delete.
  const bravo = seed('bravo', 'superuser', false);
  assert.equal(countSuperusers(), 2, 'two enabled superusers');
  pass('(b) a second enabled superuser is counted');

  // (c) the regression: bravo is disabled, so alpha is once again the only
  // account that can log in and manage users. Counting disabled rows here
  // reported 2 and let alpha delete themselves, locking everyone out.
  setDisabledAt(bravo, new Date(NOW));
  assert.equal(
    countSuperusers(),
    1,
    'a disabled superuser cannot log in and must not keep the count above 1',
  );
  assert.equal(
    deleteSelf(alpha),
    'last_superuser',
    'deleting the last *enabled* superuser must be refused even with a disabled one present',
  );
  assert.ok(
    db.select().from(users).all().some((u) => u.id === alpha),
    'the refused delete must have left the row in place',
  );
  pass('(c) a disabled superuser does not satisfy the guard');

  // (d) re-enabling restores the count and the delete goes through.
  setDisabledAt(bravo, null);
  assert.equal(countSuperusers(), 2, 're-enabling must bring the count back');
  assert.equal(deleteSelf(alpha), 'deleted', 'with a second enabled superuser the delete proceeds');
  assert.equal(countSuperusers(), 1, 'bravo is now the last superuser');
  assert.equal(deleteSelf(alpha), 'not_found', 'a second delete of a gone row is not a refusal');
  pass('(d) re-enabling unblocks the delete');
}

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
  console.error(`FAIL after ${passed}/4 assertions`);
  process.exit(1);
}

console.log(`OK ${passed}/4 assertions passed`);
process.exit(0);
