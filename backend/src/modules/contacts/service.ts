import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db/client.js';
import { contacts, scheduledMessages, type Contact } from '../../db/schema.js';

export type ListInput = { userId: string; search?: string; limit?: number };

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
      .orderBy(asc(contacts.displayName))
      .limit(cappedLimit)
      .all();
  }

  return db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .orderBy(asc(contacts.displayName))
    .limit(cappedLimit)
    .all();
}

// Quick-pick ordering: chats the user pinned *in WhatsApp* first (newest pin
// first, as WhatsApp itself orders them), then real interaction recency,
// falling back to the newest schedule created for that recipient so the list
// is useful before any WA traffic has accrued. A contact with none of the
// three signals is not "recent" and is left out entirely; a WA-pinned one
// always appears.
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
          sql`${contacts.waPinnedAt} is not null`,
          sql`${contacts.lastInteractionAt} is not null`,
          sql`${lastScheduled.lastScheduledAt} is not null`,
        ),
      ),
    )
    // SQLite has no NULLS LAST, so the `IS NULL` expression carries the block
    // ordering (0 = pinned first).
    .orderBy(
      sql`(${contacts.waPinnedAt} is null)`,
      sql`${contacts.waPinnedAt} desc`,
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

// The write half of the read-only WhatsApp pin mirror: read-only means the
// *user* never sets this through the app, not that it never changes. Fed by
// the session manager's pin buffer, UPDATE-only for the same reason as
// recordInteractions, and deliberately NOT monotonic — the newest event is the
// current state, so a null (unpin) must be able to overwrite a timestamp, and
// a re-pin with an older stamp than the last one still applies.
export function recordPinStates(
  userId: string,
  pins: ReadonlyMap<string, number | null>,
): void {
  if (pins.size === 0) return;

  sqlite
    .transaction(() => {
      for (const [jid, ms] of pins) {
        // Same reasoning as recordInteractions: updated_at means "last user
        // edit", and this is not one.
        db.update(contacts)
          .set({ waPinnedAt: ms === null ? null : new Date(ms) })
          .where(and(eq(contacts.userId, userId), eq(contacts.jid, jid)))
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
