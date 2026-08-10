import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { users, type User } from '../../db/schema.js';
import { hashPassword } from '../../lib/password.js';

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

export function deleteUserById(id: string): void {
  db.delete(users).where(eq(users.id, id)).run();
}
