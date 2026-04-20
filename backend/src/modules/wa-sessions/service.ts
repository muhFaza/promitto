import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  waConnections,
  type WaConnection,
  type WaStatus,
} from '../../db/schema.js';

type UpsertInput = {
  userId: string;
  status: WaStatus;
  jid?: string | null;
  lastError?: string | null;
  lastConnectedAt?: Date | null;
};

export function upsertStatus(input: UpsertInput): void {
  const now = new Date();
  const existing = db
    .select()
    .from(waConnections)
    .where(eq(waConnections.userId, input.userId))
    .get();

  if (existing) {
    db.update(waConnections)
      .set({
        status: input.status,
        jid: input.jid === undefined ? existing.jid : input.jid,
        lastError: input.lastError === undefined ? existing.lastError : input.lastError,
        lastConnectedAt:
          input.lastConnectedAt === undefined
            ? existing.lastConnectedAt
            : input.lastConnectedAt,
        updatedAt: now,
      })
      .where(eq(waConnections.userId, input.userId))
      .run();
  } else {
    db.insert(waConnections)
      .values({
        userId: input.userId,
        status: input.status,
        jid: input.jid ?? null,
        lastError: input.lastError ?? null,
        lastConnectedAt: input.lastConnectedAt ?? null,
        updatedAt: now,
      })
      .run();
  }
}

export function getConnection(userId: string): WaConnection | null {
  return (
    db.select().from(waConnections).where(eq(waConnections.userId, userId)).get() ?? null
  );
}

export function listConnected(): WaConnection[] {
  return db.select().from(waConnections).where(eq(waConnections.status, 'connected')).all();
}

// Normalize transient statuses left behind by a crash or hard restart.
// A process that was mid-handshake has no in-memory reconnect loop anymore,
// so the DB row should reflect reality: disconnected.
export function clearOrphanConnecting(): number {
  const res = db
    .update(waConnections)
    .set({ status: 'disconnected', lastError: null, updatedAt: new Date() })
    .where(inArray(waConnections.status, ['connecting', 'qr_pending']))
    .run();
  return res.changes;
}
