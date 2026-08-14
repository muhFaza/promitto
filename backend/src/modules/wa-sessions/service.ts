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

// Rows whose owner's intent is "be connected". 'connecting' and 'failed' are
// in here deliberately: both mean a session that was up and lost its socket,
// and a process death between the drop and the retry used to strand them
// forever (the 1s reconnect timer dies with the process; nothing re-armed it
// on the next boot). 'qr_pending' needs a human with a phone, 'disconnected'
// is an explicit user choice, and 'logged_out' had its auth dir wiped — none
// of those can be recovered by reopening a socket.
const RESTORABLE_STATUSES = ['connected', 'connecting', 'failed'] as const;

export function listRestorable(): WaConnection[] {
  return db
    .select()
    .from(waConnections)
    .where(inArray(waConnections.status, [...RESTORABLE_STATUSES]))
    .all();
}

// Same set as listRestorable(), counted rather than materialized — /api/health
// wants the number, and a second inline copy of the status list in server.ts
// would be free to drift out of sync with what restoreAll() actually attempts,
// which is the one thing a monitoring number must never do.
export function countRestorable(): number {
  const rows = db
    .select({ userId: waConnections.userId })
    .from(waConnections)
    .where(inArray(waConnections.status, [...RESTORABLE_STATUSES]))
    .all();
  return rows.length;
}

// A QR that was on screen when the process died has no watcher left, so the
// row is genuinely dead and the UI should offer Connect rather than a spinner.
// 'connecting' is deliberately NOT touched: it is now restorable, and blanking
// it here also erased lastError — the only record of why the socket dropped.
export function resetOrphanQrPending(): number {
  const res = db
    .update(waConnections)
    .set({ status: 'disconnected', lastError: null, updatedAt: new Date() })
    .where(eq(waConnections.status, 'qr_pending'))
    .run();
  return res.changes;
}
