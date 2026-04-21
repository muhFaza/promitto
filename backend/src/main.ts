// Secure defaults for files we create in this process (sqlite DB + Baileys auth state).
process.umask(0o077);

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { schedulerPoller } from './modules/scheduler/poller.js';
import { sessionManager } from './modules/wa-sessions/manager.js';
import { createApp } from './server.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Promitto backend listening');
});

const BOOT_RESTORE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

void (async () => {
  let restoreTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sessionManager.restoreAll(),
      new Promise<void>((resolve) => {
        restoreTimer = setTimeout(() => {
          logger.warn(
            { timeoutMs: BOOT_RESTORE_TIMEOUT_MS },
            'wa restoreAll timed out; poller will skip unready users',
          );
          resolve();
        }, BOOT_RESTORE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    logger.error({ err }, 'wa restoreAll failed');
  } finally {
    if (restoreTimer) clearTimeout(restoreTimer);
  }
  schedulerPoller.start();
})();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');

  const work = (async (): Promise<void> => {
    try {
      await schedulerPoller.stop();
    } catch (err) {
      logger.error({ err }, 'schedulerPoller.stop failed');
    }
    try {
      await sessionManager.shutdown();
    } catch (err) {
      logger.error({ err }, 'sessionManager.shutdown failed');
    }
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.error({ err }, 'Error during server close');
        resolve();
      });
    });
  })();

  let shutdownTimer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    shutdownTimer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([work.then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }
    logger.info('Closed cleanly.');
    process.exit(0);
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
