import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { db, sqlite } from '../../db/client.js';
import {
  scheduledMessages,
  sentMessages,
  type ScheduledMessage,
  type SentMessage,
} from '../../db/schema.js';
import { computeNextRun } from '../../lib/cron.js';
import { logger } from '../../lib/logger.js';

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000]; // 30s → 2m → 10m
const MAX_RETRIES = 3;

type CreateInput = {
  userId: string;
  recipientJid: string;
  recipientNameSnapshot: string;
  messageText: string;
  scheduleType: 'once' | 'recurring';
  cronExpression?: string | null;
  timezone: string;
  nextRunAt: Date;
};

export function create(input: CreateInput): ScheduledMessage {
  const [created] = db
    .insert(scheduledMessages)
    .values({
      id: randomUUID(),
      userId: input.userId,
      recipientJid: input.recipientJid,
      recipientNameSnapshot: input.recipientNameSnapshot,
      messageText: input.messageText,
      scheduleType: input.scheduleType,
      cronExpression: input.cronExpression ?? null,
      timezone: input.timezone,
      nextRunAt: input.nextRunAt,
      isActive: true,
    })
    .returning()
    .all();
  if (!created) throw new Error('Failed to create scheduled message');
  return created;
}

export function findById(userId: string, id: string): ScheduledMessage | null {
  return (
    db
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.userId, userId),
          eq(scheduledMessages.id, id),
        ),
      )
      .limit(1)
      .get() ?? null
  );
}

export function listUpcoming(userId: string, limit = 200): ScheduledMessage[] {
  return db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.userId, userId),
        eq(scheduledMessages.scheduleType, 'once'),
        eq(scheduledMessages.isActive, true),
      ),
    )
    .orderBy(asc(scheduledMessages.nextRunAt))
    .limit(limit)
    .all();
}

export function listRecurring(userId: string, limit = 200): ScheduledMessage[] {
  return db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.userId, userId),
        eq(scheduledMessages.scheduleType, 'recurring'),
        eq(scheduledMessages.isActive, true),
      ),
    )
    .orderBy(asc(scheduledMessages.nextRunAt))
    .limit(limit)
    .all();
}

export function listHistory(userId: string, limit = 200): SentMessage[] {
  return db
    .select()
    .from(sentMessages)
    .where(
      and(eq(sentMessages.userId, userId), eq(sentMessages.status, 'sent')),
    )
    .orderBy(desc(sentMessages.sentAt))
    .limit(limit)
    .all();
}

export function listFailed(userId: string, limit = 200): SentMessage[] {
  return db
    .select()
    .from(sentMessages)
    .where(
      and(eq(sentMessages.userId, userId), eq(sentMessages.status, 'failed')),
    )
    .orderBy(desc(sentMessages.sentAt))
    .limit(limit)
    .all();
}

type UpdateInput = {
  messageText?: string;
  cronExpression?: string | null;
  timezone?: string;
  nextRunAt?: Date;
};

export function updateActive(
  userId: string,
  id: string,
  patch: UpdateInput,
): ScheduledMessage | null {
  const existing = findById(userId, id);
  if (!existing || !existing.isActive) return null;

  const updates: Partial<typeof scheduledMessages.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.messageText !== undefined) updates.messageText = patch.messageText;
  if (patch.cronExpression !== undefined) updates.cronExpression = patch.cronExpression;
  if (patch.timezone !== undefined) updates.timezone = patch.timezone;
  if (patch.nextRunAt !== undefined) updates.nextRunAt = patch.nextRunAt;

  db.update(scheduledMessages)
    .set(updates)
    .where(
      and(eq(scheduledMessages.userId, userId), eq(scheduledMessages.id, id)),
    )
    .run();
  return findById(userId, id);
}

export function cancel(userId: string, id: string): boolean {
  const existing = findById(userId, id);
  if (!existing) return false;
  db.update(scheduledMessages)
    .set({ isActive: false, pickedAt: null, updatedAt: new Date() })
    .where(
      and(eq(scheduledMessages.userId, userId), eq(scheduledMessages.id, id)),
    )
    .run();
  return true;
}

export function countPendingOnce(userId: string): number {
  const rows = db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.userId, userId),
        eq(scheduledMessages.scheduleType, 'once'),
        eq(scheduledMessages.isActive, true),
      ),
    )
    .all();
  return rows.length;
}

// Atomic claim of due rows — BEGIN IMMEDIATE is mandatory per project plan.
const beginImmediate = sqlite.prepare('BEGIN IMMEDIATE');
const commit = sqlite.prepare('COMMIT');
const rollback = sqlite.prepare('ROLLBACK');

export function pickDue(limit: number): ScheduledMessage[] {
  beginImmediate.run();
  try {
    const now = new Date();
    const due = db
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.isActive, true),
          lte(scheduledMessages.nextRunAt, now),
          isNull(scheduledMessages.pickedAt),
        ),
      )
      .orderBy(asc(scheduledMessages.nextRunAt))
      .limit(limit)
      .all();

    if (due.length > 0) {
      const ids = due.map((r) => r.id);
      db.update(scheduledMessages)
        .set({ pickedAt: now })
        .where(inArray(scheduledMessages.id, ids))
        .run();
    }
    commit.run();
    return due;
  } catch (err) {
    rollback.run();
    throw err;
  }
}

export function recordAttemptSuccess(row: ScheduledMessage): void {
  const now = new Date();
  db.insert(sentMessages)
    .values({
      id: randomUUID(),
      scheduledMessageId: row.id,
      userId: row.userId,
      recipientJid: row.recipientJid,
      messageTextSnapshot: row.messageText,
      status: 'sent',
      sentAt: now,
    })
    .run();

  if (row.scheduleType === 'once') {
    db.update(scheduledMessages)
      .set({
        isActive: false,
        pickedAt: null,
        lastRunAt: now,
        lastStatus: 'sent',
        lastError: null,
        retryCount: 0,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, row.id))
      .run();
    return;
  }

  // Recurring — compute next run; if cron is broken, deactivate.
  const cron = row.cronExpression;
  if (!cron) {
    deactivateWithError(row.id, now, 'sent', null);
    return;
  }
  try {
    const nextRunAt = computeNextRun(cron, row.timezone, now);
    db.update(scheduledMessages)
      .set({
        pickedAt: null,
        lastRunAt: now,
        lastStatus: 'sent',
        lastError: null,
        retryCount: 0,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, row.id))
      .run();
  } catch (err) {
    logger.error({ err, id: row.id }, 'recurring computeNextRun failed — deactivating');
    deactivateWithError(row.id, now, 'sent', null);
  }
}

export function recordAttemptFailure(row: ScheduledMessage, error: string): void {
  const now = new Date();
  db.insert(sentMessages)
    .values({
      id: randomUUID(),
      scheduledMessageId: row.id,
      userId: row.userId,
      recipientJid: row.recipientJid,
      messageTextSnapshot: row.messageText,
      status: 'failed',
      error,
      sentAt: now,
    })
    .run();

  const newRetry = row.retryCount + 1;

  if (newRetry < MAX_RETRIES) {
    const backoffMs =
      BACKOFF_MS[Math.min(newRetry - 1, BACKOFF_MS.length - 1)] ??
      BACKOFF_MS[BACKOFF_MS.length - 1]!;
    db.update(scheduledMessages)
      .set({
        pickedAt: null,
        retryCount: newRetry,
        lastStatus: 'failed',
        lastError: error,
        nextRunAt: new Date(now.getTime() + backoffMs),
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, row.id))
      .run();
    return;
  }

  // Max retries exhausted
  if (row.scheduleType === 'once') {
    db.update(scheduledMessages)
      .set({
        isActive: false,
        pickedAt: null,
        lastRunAt: now,
        lastStatus: 'failed',
        lastError: error,
        retryCount: newRetry,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, row.id))
      .run();
    return;
  }

  // Recurring — skip to next natural occurrence; reset retry count.
  const cron = row.cronExpression;
  if (!cron) {
    deactivateWithError(row.id, now, 'failed', error);
    return;
  }
  try {
    const nextRunAt = computeNextRun(cron, row.timezone, now);
    db.update(scheduledMessages)
      .set({
        pickedAt: null,
        lastRunAt: now,
        lastStatus: 'failed',
        lastError: error,
        retryCount: 0,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, row.id))
      .run();
  } catch (err) {
    logger.error(
      { err, id: row.id },
      'recurring computeNextRun failed after exhaust — deactivating',
    );
    deactivateWithError(row.id, now, 'failed', error);
  }
}

function deactivateWithError(
  id: string,
  now: Date,
  status: 'sent' | 'failed',
  error: string | null,
): void {
  db.update(scheduledMessages)
    .set({
      isActive: false,
      pickedAt: null,
      lastRunAt: now,
      lastStatus: status,
      lastError: error,
      retryCount: 0,
      updatedAt: now,
    })
    .where(eq(scheduledMessages.id, id))
    .run();
}
