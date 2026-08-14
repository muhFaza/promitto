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
  // Started after the restore race, not before: the supervisor and restoreAll
  // both open sockets, and letting them overlap would race the same handle.
  sessionManager.startSupervisor();
})();

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  // Idempotent: a second signal, or a fault raised while we are already
  // unwinding, must not run the teardown twice — sessionManager.shutdown()
  // closing sockets underneath itself is how you turn a clean exit into a
  // hung one.
  if (shuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress; ignoring');
    return;
  }
  shuttingDown = true;
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
      // server.close() waits for every open connection to end on its own, and
      // the /api/wa/events SSE streams never do. Without this the clean path is
      // unreachable whenever anyone has the app open, and shutdown always falls
      // through to the force-exit timer.
      server.closeAllConnections();
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
    process.exit(exitCode);
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
  }
}

function onSignal(signal: string): void {
  shutdown(signal).catch((err: unknown) => {
    logger.error({ err, signal }, 'shutdown threw, forcing exit');
    process.exit(1);
  });
}

process.on('SIGTERM', () => {
  onSignal('SIGTERM');
});
process.on('SIGINT', () => {
  onSignal('SIGINT');
});

// Until now there was no handler for either of these, so a stray rejection took
// the process down with no log line at all — the blind spot that made the
// every-three-days heap death impossible to attribute. We exit rather than
// continue on purpose: a process in an unknown state must not keep driving
// WhatsApp sockets or firing the scheduler. Non-zero, so Docker's
// unless-stopped policy restarts us, and the graceful path still runs so
// Baileys closes its sockets cleanly and pending contacts get flushed.
function onFatal(kind: string, err: unknown): void {
  logger.fatal({ err, kind }, 'fatal error — shutting down');
  if (shuttingDown) {
    // The fault came from inside the teardown. Re-entering it would deadlock
    // against itself; the exit is the only guaranteed progress left.
    process.exit(1);
    return;
  }
  shutdown(kind, 1).catch((inner: unknown) => {
    logger.error({ err: inner, kind }, 'shutdown after fatal error threw');
    process.exit(1);
  });
}

process.on('unhandledRejection', (reason) => {
  onFatal('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  onFatal('uncaughtException', err);
});
