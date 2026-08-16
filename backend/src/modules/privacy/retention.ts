import { and, eq, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, sqlite } from '../../db/client.js';
import { scheduledMessages, sentMessages, users } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export type SweepCounts = { sentMessages: number; scheduledMessages: number };

/**
 * Delete one user's expired data. Hard delete, not redaction: a retained row
 * would still record who was messaged and when, which is the thing retention is
 * meant to stop keeping.
 *
 * Only finished one-off schedules expire. Active rows and every recurring row
 * survive regardless of age — a recurring schedule is live configuration, not
 * history, and deleting one would silently stop a user's messages.
 *
 * `retentionDays: 0` puts the cutoff at `now`, i.e. delete everything that has
 * already happened. That is what the user-initiated purge passes.
 *
 * `opts.dryRun` defaults to `RETENTION_DRY_RUN` so the periodic sweep can be
 * observed before it is trusted, but a caller that passes `{ dryRun: false }`
 * always deletes for real — a user asking for their data to be gone must never
 * silently no-op because an operator flag is set.
 */
export function sweepUser(
  userId: string,
  retentionDays: number,
  opts: { now?: number; dryRun?: boolean } = {},
): SweepCounts {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? env.RETENTION_DRY_RUN;
  const cutoff = new Date(now - retentionDays * DAY_MS);

  const sentWhere = and(eq(sentMessages.userId, userId), lt(sentMessages.sentAt, cutoff));
  const schedWhere = and(
    eq(scheduledMessages.userId, userId),
    eq(scheduledMessages.isActive, false),
    eq(scheduledMessages.scheduleType, 'once'),
    lt(scheduledMessages.updatedAt, cutoff),
  );

  if (dryRun) {
    const sent = db
      .select({ n: sql<number>`count(*)` })
      .from(sentMessages)
      .where(sentWhere)
      .get();
    const sched = db
      .select({ n: sql<number>`count(*)` })
      .from(scheduledMessages)
      .where(schedWhere)
      .get();
    return { sentMessages: sent?.n ?? 0, scheduledMessages: sched?.n ?? 0 };
  }

  const run = sqlite.transaction((): SweepCounts => {
    const sent = db.delete(sentMessages).where(sentWhere).run();
    const sched = db.delete(scheduledMessages).where(schedWhere).run();
    return { sentMessages: sent.changes, scheduledMessages: sched.changes };
  });

  return run.immediate();
}

class RetentionSweeper {
  private interval: NodeJS.Timeout | null = null;
  private sweeping = false;
  private stopped = false;

  start(): void {
    if (this.interval) return;
    this.stopped = false;

    this.interval = setInterval(() => {
      this.tick();
    }, SWEEP_INTERVAL_MS);
    // Fire once immediately: the sweep is idempotent and a container that is
    // restarted more often than the interval would otherwise never sweep.
    this.tick();
    logger.info(
      { intervalMs: SWEEP_INTERVAL_MS, dryRun: env.RETENTION_DRY_RUN },
      'retention sweeper started',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    // The tick is synchronous (better-sqlite3), so this can only be true if
    // stop() were called re-entrantly from inside it. Kept to match the
    // scheduler poller's contract: stop() resolves only once nothing is running.
    while (this.sweeping) {
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.info('retention sweeper stopped');
  }

  private tick(): void {
    if (this.stopped || this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db
        .select({ id: users.id, retentionDays: users.retentionDays })
        .from(users)
        .all();
      let sent = 0;
      let scheduled = 0;
      for (const row of rows) {
        if (this.stopped) break;
        try {
          const counts = sweepUser(row.id, row.retentionDays);
          sent += counts.sentMessages;
          scheduled += counts.scheduledMessages;
        } catch (err) {
          logger.error({ err, userId: row.id }, 'retention sweep failed for user');
        }
      }
      if (sent > 0 || scheduled > 0) {
        logger.info(
          { sentMessages: sent, scheduledMessages: scheduled, dryRun: env.RETENTION_DRY_RUN },
          env.RETENTION_DRY_RUN ? 'retention sweep (dry run)' : 'retention sweep complete',
        );
      } else {
        logger.debug('retention sweep found nothing to delete');
      }
    } catch (err) {
      logger.error({ err }, 'retention sweep tick failed');
    } finally {
      this.sweeping = false;
    }
  }
}

export const retentionSweeper = new RetentionSweeper();
