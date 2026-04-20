import { randomUUID } from 'node:crypto';
import { and, asc, eq, like, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { contacts, type Contact } from '../../db/schema.js';

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

export function remove(userId: string, id: string): boolean {
  const row = findById(userId, id);
  if (!row) return false;
  db.delete(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
    .run();
  return true;
}
