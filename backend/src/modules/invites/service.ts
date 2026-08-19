import { and, eq, isNull, lte } from 'drizzle-orm';
import { db, sqlite } from '../../db/client.js';
import { invites, users } from '../../db/schema.js';
import { INVITE_TTL_MS, generateInviteToken, hashInviteToken } from '../../lib/invite-token.js';

export type IssuedInvite = { token: string; expiresAt: Date };

// Returns the RAW token — the only moment in the system's lifetime that it
// exists. Caller must hand it straight to the admin and never persist it.
export function issueInvite(userId: string): IssuedInvite {
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  sqlite.transaction(() => {
    // Opportunistic GC: nothing else prunes this table, and expired rows are
    // dead weight that still name a user.
    db.delete(invites).where(lte(invites.expiresAt, now)).run();
    // user_id is UNIQUE, so reissuing must replace — the previous link dies here.
    db.delete(invites).where(eq(invites.userId, userId)).run();
    db.insert(invites).values({ tokenHash, userId, expiresAt, createdAt: now }).run();
  }).immediate();

  return { token, expiresAt };
}

export type ValidInvite = { userId: string; email: string; expiresAt: Date };

export function findValidInvite(token: string): ValidInvite | null {
  const rows = db
    .select({
      userId: invites.userId,
      email: users.email,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .innerJoin(users, eq(invites.userId, users.id))
    .where(and(eq(invites.tokenHash, hashInviteToken(token)), isNull(users.disabledAt)))
    .limit(1)
    .all();

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

// The password hash is computed by the CALLER, outside this function: argon2 is
// async and better-sqlite3 transactions are synchronous, so hashing inside the
// tx is impossible. The window between validation and this call is closed by
// re-reading and re-checking everything inside the transaction below; deleting
// the invite row in that same transaction is what makes the link single-use.
export function consumeInvite(
  token: string,
  passwordHash: string,
): { userId: string } | null {
  const tokenHash = hashInviteToken(token);

  return sqlite.transaction(() => {
    const rows = db
      .select({
        userId: invites.userId,
        expiresAt: invites.expiresAt,
        disabledAt: users.disabledAt,
      })
      .from(invites)
      .innerJoin(users, eq(invites.userId, users.id))
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1)
      .all();

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.disabledAt) return null;

    // Written inline rather than via users/service.ts:setPassword — that helper
    // is async and would land outside this transaction.
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, row.userId))
      .run();
    db.delete(invites).where(eq(invites.tokenHash, tokenHash)).run();

    return { userId: row.userId };
  }).immediate();
}
