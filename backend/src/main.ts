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

sessionManager.restoreAll().catch((err: unknown) => {
  logger.error({ err }, 'wa restoreAll failed');
});

schedulerPoller.start();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');
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
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during server close');
      process.exit(1);
    }
    logger.info('Closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
