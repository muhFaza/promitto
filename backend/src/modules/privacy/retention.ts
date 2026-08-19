import { and, eq, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, sqlite } from '../../db/client.js';
import { scheduledMessages, sentMessages, users } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

// The same set the settings route accepts. Duplicated here on purpose: the
// column has no CHECK constraint, so a row written by an older release, a hand
// edit, or a future bug is the case this guards against — not the HTTP path.
const ALLOWED_RETENTION_DAYS: ReadonlySet<number> = new Set([7, 30, 60, 90, 180]);

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
 *
 * `retentionDays` is validated here and not only at the HTTP edge: a negative
 * or NaN value future-dates the cutoff, and since NaN comparisons and a
 * far-future cutoff both resolve to "everything is expired", the failure mode
 * of a bad number is deleting a user's entire history. There are no backups.
 */
export function sweepUser(
  userId: string,
  retentionDays: number,
  opts: { now?: number; dryRun?: boolean } = {},
): SweepCounts {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(
      `sweepUser: retentionDays must be a non-negative integer, got ${String(retentionDays)}`,
    );
  }
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

/**
 * What the last periodic pass did. Exposed on /api/health because the sweep is
 * unattended and silent when it deletes nothing: at `LOG_LEVEL=info` six
 * healthy zero-delete passes and a wedged timer produce exactly the same output
 * (none). `lastCompletedAt` moving is the proof the timer is alive; `lastError`
 * is the proof it is not failing quietly.
 *
 * All timestamps are epoch ms, matching the wire convention everywhere else.
 * `null` means "has not happened yet" — a fresh container has a null
 * `lastCompletedAt` for a moment, which is not a fault.
 */
export type RetentionStatus = {
  /** Start of the most recent tick. */
  lastStartedAt: number | null;
  /** End of the most recent tick that ran to completion. */
  lastCompletedAt: number | null;
  /** Rows deleted (or, under dryRun, matched) by that completed tick. */
  lastCounts: SweepCounts | null;
  /** Message from the last tick that threw, cleared by the next clean tick. */
  lastError: string | null;
  /** RETENTION_DRY_RUN: when true nothing is actually deleted. */
  dryRun: boolean;
  /** Whether the interval timer is currently armed. */
  running: boolean;
};

class RetentionSweeper {
  private interval: NodeJS.Timeout | null = null;
  private sweeping = false;
  private stopped = false;
  private lastStartedAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private lastCounts: SweepCounts | null = null;
  private lastError: string | null = null;

  /** Never throws — /api/health must not be able to 500 on this. */
  getStatus(): RetentionStatus {
    return {
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastCounts: this.lastCounts,
      lastError: this.lastError,
      dryRun: env.RETENTION_DRY_RUN,
      running: this.interval !== null,
    };
  }

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
    this.lastStartedAt = Date.now();
    try {
      const rows = db
        .select({ id: users.id, retentionDays: users.retentionDays })
        .from(users)
        .all();
      let sent = 0;
      let scheduled = 0;
      // A per-user failure does not abort the tick, but it must still surface:
      // it is the exact case that is otherwise invisible at LOG_LEVEL=info.
      let tickError: string | null = null;
      for (const row of rows) {
        if (this.stopped) break;
        // Skip rather than sweep with a value we don't recognise. The periodic
        // sweep is unattended and deletes for real; a garbage retention_days is
        // a reason to leave that user's data alone and complain, not to guess.
        if (!ALLOWED_RETENTION_DAYS.has(row.retentionDays)) {
          logger.warn(
            { userId: row.id, retentionDays: row.retentionDays },
            'skipping retention sweep: retention_days is not an allowed value',
          );
          continue;
        }
        try {
          const counts = sweepUser(row.id, row.retentionDays);
          sent += counts.sentMessages;
          scheduled += counts.scheduledMessages;
        } catch (err) {
          logger.error({ err, userId: row.id }, 'retention sweep failed for user');
          tickError = err instanceof Error ? err.message : String(err);
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
      this.lastCounts = { sentMessages: sent, scheduledMessages: scheduled };
      this.lastError = tickError;
      this.lastCompletedAt = Date.now();
    } catch (err) {
      logger.error({ err }, 'retention sweep tick failed');
      // lastCompletedAt deliberately untouched: the tick did not complete, and
      // a stale-but-honest timestamp next to a non-null lastError is what tells
      // an operator how long it has been broken.
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.sweeping = false;
    }
  }
}

export const retentionSweeper = new RetentionSweeper();
