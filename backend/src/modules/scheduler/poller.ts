import type { ScheduledMessage } from '../../db/schema.js';
import { randomJitterMs } from '../../lib/jitter.js';
import { logger } from '../../lib/logger.js';
import { sessionManager } from '../wa-sessions/manager.js';
import * as service from './service.js';

const TICK_MS = 30_000;
const MAX_PER_TICK = 50;

class SchedulerPoller {
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.interval = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // Fire once immediately so near-due rows don't wait up to 30s on boot.
    void this.tick();
    logger.info({ intervalMs: TICK_MS }, 'scheduler poller started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    while (this.ticking) {
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.info('scheduler poller stopped');
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const due = service.pickDue(MAX_PER_TICK);
      if (due.length > 0) {
        logger.info({ count: due.length }, 'scheduler picked due messages');
      }
      for (const row of due) {
        if (this.stopped) break;
        await this.processRow(row);
      }
    } catch (err) {
      logger.error({ err }, 'scheduler tick error');
    } finally {
      this.ticking = false;
    }
  }

  private async processRow(row: ScheduledMessage): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, randomJitterMs()));
      if (this.stopped) return;

      const result = await sessionManager.sendText(
        row.userId,
        row.recipientJid,
        row.messageText,
      );

      if (result.ok) {
        logger.info(
          { id: row.id, userId: row.userId },
          'scheduled message sent',
        );
        service.recordAttemptSuccess(row);
      } else {
        logger.warn(
          { id: row.id, userId: row.userId, error: result.error, retry: row.retryCount },
          'scheduled message send failed',
        );
        service.recordAttemptFailure(row, result.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, id: row.id }, 'scheduler processRow crashed');
      try {
        service.recordAttemptFailure(row, msg);
      } catch (inner) {
        logger.error({ err: inner }, 'recordAttemptFailure also crashed');
      }
    }
  }
}

export const schedulerPoller = new SchedulerPoller();
