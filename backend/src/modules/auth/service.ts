import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions, users, type Session, type User } from '../../db/schema.js';
import { ABSOLUTE_SESSION_MAX_MS, SESSION_DURATION_MS } from '../../config/constants.js';
import { generateSessionId } from '../../lib/session-id.js';

type CreateSessionInput = {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
};

export function createSession(input: CreateSessionInput): Session {
  const id = generateSessionId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  const [created] = db
    .insert(sessions)
    .values({
      id,
      userId: input.userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .returning()
    .all();

  if (!created) throw new Error('Failed to create session');
  return created;
}

export function getSessionWithUser(
  sessionId: string,
): { session: Session; user: User } | null {
  const now = new Date();
  const rows = db
    .select()
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .limit(1)
    .all();

  const row = rows[0];
  if (!row) return null;
  return { session: row.sessions, user: row.users };
}

export function touchSession(sessionId: string): void {
  const now = new Date();
  // Slide the 30-day window, but never past createdAt + ABSOLUTE_SESSION_MAX_MS.
  // Computed in SQL so it stays a single UPDATE with no read-modify-write race.
  db.update(sessions)
    .set({
      lastSeenAt: now,
      expiresAt: sql`min(
        ${now.getTime() + SESSION_DURATION_MS},
        ${sessions.createdAt} + ${ABSOLUTE_SESSION_MAX_MS}
      )`,
    })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function deleteSession(sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function deleteAllSessionsForUser(userId: string, exceptSessionId?: string): void {
  if (exceptSessionId) {
    db.delete(sessions)
      .where(and(eq(sessions.userId, userId), sql`${sessions.id} != ${exceptSessionId}`))
      .run();
  } else {
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }
}

// Login-time housekeeping. Multi-device is supported by design, so logging in
// must NOT revoke the user's other live sessions — only reap dead rows, which
// would otherwise accumulate forever now that nothing else prunes them.
// Admin-initiated revocation (disable / delete / reset-password) still uses
// deleteAllSessionsForUser and is unaffected.
export function deleteExpiredSessionsForUser(userId: string): void {
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} <= ${Date.now()}`))
    .run();
}

export function findUserByEmail(email: string): User | null {
  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1)
    .all();
  return rows[0] ?? null;
}
