import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db/client.js';
import { contacts, scheduledMessages, type Contact } from '../../db/schema.js';

export type ListInput = { userId: string; search?: string; limit?: number };

// Pinned contacts sort ahead of everything else; SQLite has no NULLS LAST, so
// the `IS NULL` expression carries the block ordering (0 = pinned first).
const pinnedFirst = sql`(${contacts.pinnedAt} is null)`;

export function list({ userId, search, limit = 50 }: ListInput): Contact[] {
  const cappedLimit = Math.min(Math.max(1, limit), 200);
  const trimmed = search?.trim();

  if (trimmed) {
    const escaped = trimmed.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    return db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            like(contacts.displayName, pattern),
            like(contacts.phone, pattern),
            like(contacts.jid, pattern),
          ),
        ),
      )
      .orderBy(pinnedFirst, asc(contacts.pinnedAt), asc(contacts.displayName))
      .limit(cappedLimit)
      .all();
  }

  return db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .orderBy(pinnedFirst, asc(contacts.pinnedAt), asc(contacts.displayName))
    .limit(cappedLimit)
    .all();
}

// Quick-pick ordering: pinned contacts first (stable, by pin time), then the
// rest by real WhatsApp interaction recency, falling back to the newest
// schedule created for that recipient so the list is useful before any WA
// traffic has accrued. A contact with neither signal is not "recent" and is
// left out — pinning is the only way to force one in.
export function listRecent(userId: string, limit = 8): Contact[] {
  const cappedLimit = Math.min(Math.max(1, limit), 50);

  const lastScheduled = db
    .select({
      recipientJid: scheduledMessages.recipientJid,
      lastScheduledAt: sql<number | null>`max(${scheduledMessages.createdAt})`.as(
        'last_scheduled_at',
      ),
    })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.userId, userId))
    .groupBy(scheduledMessages.recipientJid)
    .as('ls');

  const rows = db
    .select({ contact: contacts })
    .from(contacts)
    .leftJoin(lastScheduled, eq(contacts.jid, lastScheduled.recipientJid))
    .where(
      and(
        eq(contacts.userId, userId),
        or(
          sql`${contacts.pinnedAt} is not null`,
          sql`${contacts.lastInteractionAt} is not null`,
          sql`${lastScheduled.lastScheduledAt} is not null`,
        ),
      ),
    )
    .orderBy(
      pinnedFirst,
      asc(contacts.pinnedAt),
      sql`coalesce(${contacts.lastInteractionAt}, ${lastScheduled.lastScheduledAt}) desc`,
    )
    .limit(cappedLimit)
    .all();

  return rows.map((r) => r.contact);
}

export function findById(userId: string, id: string): Contact | null {
  return (
    db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
      .limit(1)
      .get() ?? null
  );
}

export function findByJid(userId: string, jid: string): Contact | null {
  return (
    db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.jid, jid)))
      .limit(1)
      .get() ?? null
  );
}

type InsertManualInput = {
  userId: string;
  jid: string;
  displayName: string;
  phone: string;
  verifiedOnWhatsapp: boolean | null;
};

export function insertManual(input: InsertManualInput): Contact {
  const now = new Date();
  const [created] = db
    .insert(contacts)
    .values({
      id: randomUUID(),
      userId: input.userId,
      jid: input.jid,
      displayName: input.displayName.trim(),
      phone: input.phone,
      source: 'manual',
      verifiedOnWhatsapp: input.verifiedOnWhatsapp,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!created) throw new Error('Failed to insert contact');
  return created;
}

type SyncedInput = {
  userId: string;
  jid: string;
  displayName: string;
  phone: string;
};

export function upsertSynced(input: SyncedInput): void {
  const existing = findByJid(input.userId, input.jid);

  if (!existing) {
    db.insert(contacts)
      .values({
        id: randomUUID(),
        userId: input.userId,
        jid: input.jid,
        displayName: input.displayName,
        phone: input.phone,
        source: 'synced',
        verifiedOnWhatsapp: true,
      })
      .run();
    return;
  }

  if (existing.source === 'manual') {
    // preserve manual display name; just confirm existence on WA
    db.update(contacts)
      .set({ verifiedOnWhatsapp: true, updatedAt: new Date() })
      .where(eq(contacts.id, existing.id))
      .run();
    return;
  }

  // synced → refresh display name + phone
  db.update(contacts)
    .set({
      displayName: input.displayName,
      phone: input.phone,
      verifiedOnWhatsapp: true,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, existing.id))
    .run();
}

export function rename(userId: string, id: string, displayName: string): Contact | null {
  db.update(contacts)
    .set({ displayName: displayName.trim(), updatedAt: new Date() })
    .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
    .run();
  return findById(userId, id);
}

export function setPinned(userId: string, id: string, pinned: boolean): Contact | null {
  const now = new Date();
  if (pinned) {
    // `isNull` guard keeps a repeat pin from restamping pinned_at, which would
    // reshuffle the pinned block under the caller.
    db.update(contacts)
      .set({ pinnedAt: now, updatedAt: now })
      .where(
        and(
          eq(contacts.userId, userId),
          eq(contacts.id, id),
          isNull(contacts.pinnedAt),
        ),
      )
      .run();
  } else {
    db.update(contacts)
      .set({ pinnedAt: null, updatedAt: now })
      .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
      .run();
  }
  return findById(userId, id);
}

// A PATCH carrying both keys must not half-apply: as two independent statements
// a failure between them leaves a renamed-but-unpinned row behind a 500.
export function applyPatch(
  userId: string,
  id: string,
  patch: { displayName?: string; pinned?: boolean },
): Contact | null {
  return sqlite
    .transaction((): Contact | null => {
      let row = findById(userId, id);
      if (!row) return null;
      if (patch.displayName !== undefined) {
        row = rename(userId, id, patch.displayName);
        if (!row) return null;
      }
      if (patch.pinned !== undefined) {
        row = setPinned(userId, id, patch.pinned);
        if (!row) return null;
      }
      return row;
    })
    .immediate();
}

// Fed by the WA session manager's debounced interaction buffer. UPDATE-only by
// design: chats arrive from numbers that were never saved as contacts and carry
// no usable display name, so contact creation stays with contacts.upsert. The
// timestamp guard makes a late-arriving older event a no-op.
export function recordInteractions(
  userId: string,
  interactions: ReadonlyMap<string, number>,
): void {
  if (interactions.size === 0) return;

  sqlite
    .transaction(() => {
      for (const [jid, ms] of interactions) {
        const at = new Date(ms);
        // Deliberately does NOT touch updated_at — that column means "last user
        // edit", and bumping it here would silently redefine it as "last WA
        // message" for every contact the user talks to.
        db.update(contacts)
          .set({ lastInteractionAt: at })
          .where(
            and(
              eq(contacts.userId, userId),
              eq(contacts.jid, jid),
              or(
                isNull(contacts.lastInteractionAt),
                lt(contacts.lastInteractionAt, at),
              ),
            ),
          )
          .run();
      }
    })
    .immediate();
}

export function remove(userId: string, id: string): boolean {
  const row = findById(userId, id);
  if (!row) return false;
  db.delete(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
    .run();
  return true;
}
