import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, sqlite } from '../../db/client.js';
import { users, type User } from '../../db/schema.js';
import { hashPassword } from '../../lib/password.js';
import { DEFAULT_RETENTION_DAYS } from '../privacy/retention.js';

export function listUsers(): User[] {
  return db.select().from(users).orderBy(users.createdAt).all();
}

export function findUserById(id: string): User | null {
  const rows = db.select().from(users).where(eq(users.id, id)).limit(1).all();
  return rows[0] ?? null;
}

export function findUserByEmailAnyRole(email: string): User | null {
  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function findSuperuserByEmail(email: string): User | null {
  const rows = db
    .select()
    .from(users)
    .where(and(eq(users.email, email.trim().toLowerCase()), eq(users.role, 'superuser')))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

type CreateUserInput = {
  email: string;
  role: 'user' | 'superuser';
  timezone?: string;
  password: string;
  mustChangePassword?: boolean;
};

export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  const [created] = db
    .insert(users)
    .values({
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      role: input.role,
      timezone: input.timezone ?? env.DEFAULT_TIMEZONE,
      passwordHash,
      mustChangePassword: input.mustChangePassword ?? false,
      // Explicit rather than leaning on the column default — see schema.ts.
      retentionDays: DEFAULT_RETENTION_DAYS,
    })
    .returning()
    .all();
  if (!created) throw new Error('Failed to create user');
  return created;
}

export function setDisabledAt(id: string, disabledAt: Date | null): void {
  db.update(users)
    .set({ disabledAt, updatedAt: new Date() })
    .where(eq(users.id, id))
    .run();
}

type SetPasswordOptions = {
  mustChangePassword?: boolean;
};

export async function setPassword(
  id: string,
  newPlain: string,
  options: SetPasswordOptions = {},
): Promise<void> {
  const passwordHash = await hashPassword(newPlain);
  db.update(users)
    .set({
      passwordHash,
      mustChangePassword: options.mustChangePassword ?? false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .run();
}

export function setTimezone(id: string, timezone: string): void {
  db.update(users).set({ timezone, updatedAt: new Date() }).where(eq(users.id, id)).run();
}

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

// Read per flush rather than cached on the WA handle: better-sqlite3 is
// synchronous and this is a single indexed lookup, and it stays correct when a
// user flips the toggle mid-session with no cache to invalidate. A user who no
// longer exists reads as disabled, which is the safe direction.
export function isContactSyncEnabled(id: string): boolean {
  const row = db
    .select({ enabled: users.contactSyncEnabled })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return row?.enabled ?? false;
}

/**
 * Superusers who can actually log in. Disabled rows are excluded deliberately:
 * `requireAuth` rejects on `disabledAt`, so a disabled superuser cannot manage
 * users and cannot re-enable themselves. Counting them would let superuser A
 * disable superuser B and then delete themselves — the guard sees two, and the
 * instance is left with no usable superuser and no signup path to recover.
 *
 * Both callers ask the same question ("would deleting this account leave nobody
 * able to manage users?"), so both want the logged-in-capable count.
 */
export function countSuperusers(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'superuser'), isNull(users.disabledAt)))
    .get();
  return row?.n ?? 0;
}

export function deleteUserById(id: string): void {
  db.delete(users).where(eq(users.id, id)).run();
}

export type SelfDeleteResult = 'deleted' | 'last_superuser' | 'not_found';

/**
 * Self-deletion, with the last-superuser check and the delete in one
 * BEGIN IMMEDIATE. The route checks first as a cheap early exit, but that check
 * and the delete are separated by an awaited WhatsApp logout and the auth-state
 * purge — two superusers deleting at the same moment would both pass it and
 * leave the instance with nobody who can manage users, and there is no signup
 * path to recover.
 *
 * The role is re-read from the DB rather than taken from `req.user`, which is a
 * snapshot taken at authentication time.
 *
 * `not_found` means the row is already gone; the caller should treat the
 * deletion as done rather than as a refusal.
 */
export function deleteSelf(id: string): SelfDeleteResult {
  const run = sqlite.transaction((): SelfDeleteResult => {
    const row = db.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
    if (!row) return 'not_found';
    if (row.role === 'superuser' && countSuperusers() <= 1) return 'last_superuser';
    db.delete(users).where(eq(users.id, id)).run();
    return 'deleted';
  });
  return run.immediate();
}
