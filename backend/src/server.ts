import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { sqlite } from './db/client.js';
import { memorySnapshot } from './lib/memory-monitor.js';
import { errorMiddleware } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { authRouter } from './modules/auth/routes.js';
import { contactsRouter } from './modules/contacts/routes.js';
import { invitesRouter } from './modules/invites/routes.js';
import { schedulerRouter } from './modules/scheduler/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { sessionManager } from './modules/wa-sessions/manager.js';
import { waRouter } from './modules/wa-sessions/routes.js';
import { countRestorable } from './modules/wa-sessions/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    let dbOk = false;
    try {
      sqlite.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    // `wa.expected` counts rows that *should* have a live socket — literally the
    // same set restoreAll() and the supervisor act on, via one shared helper so
    // this number can't drift away from what the app actually attempts. Compare
    // it against `wa.connected` to spot a container that is up and serving while
    // every WhatsApp session is dead — which happened for 1h15m unnoticed.
    // Counted once and reused for both fields: two calls could disagree, and the
    // in-memory count is taken first so a throw from the DB count below still
    // leaves `sessions` accurate.
    let sessions = 0;
    let wa: { expected: number; connected: number; lastCheckAt: number | null } | undefined;
    try {
      sessions = sessionManager.getConnectedCount();
      const lastCheckAt = sessionManager.getLastReconcileAt();
      // lastCheckAt proves the supervisor's timer is still alive. An idle tick
      // logs nothing, so without this a wedged supervisor and a healthy one look
      // identical from outside — null means it has not completed a tick yet.
      wa = {
        expected: countRestorable(),
        connected: sessions,
        lastCheckAt: lastCheckAt === 0 ? null : lastCheckAt,
      };
    } catch {
      // Never let health throw: a 500 here trips the deploy gate's rollback.
      wa = undefined;
    }

    // Point-in-time heap, so pressure can be read without shelling into the box
    // and grepping the 5-minute telemetry line. Deliberately compact — the
    // trend lives in the logs; this is the "how is it right now" answer.
    let mem: { rssMb: number; heapUsedMb: number; heapUsedPct: number } | undefined;
    try {
      mem = memorySnapshot();
    } catch {
      mem = undefined;
    }

    res.json({
      // `status` is driven by the DB check ALONE, deliberately. Do not fold WA
      // state into it: .github/workflows/deploy.yml greps for "status":"ok" to
      // decide whether to roll back, and a fresh container legitimately takes
      // ~13s to restore its sessions — WA-aware status would roll back every
      // deploy. Read the `wa` block below for session health instead.
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      // Kept for backward compatibility with existing probes; same value as wa.connected.
      sessions,
      ...(wa ? { wa } : {}),
      ...(mem ? { mem } : {}),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  // Public + unauthenticated by design; see modules/invites/routes.ts.
  app.use('/api/invite', invitesRouter);
  app.use('/api/wa', waRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/scheduler', schedulerRouter);
  app.use('/api/settings', settingsRouter);

  if (env.NODE_ENV === 'production') {
    // From compiled output (backend/dist/server.js) → parent of backend → frontend/dist
    const frontendDir = resolve(__dirname, '../../frontend/dist');

    // Hashed assets: long, immutable cache
    app.use(
      '/assets',
      express.static(join(frontendDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      }),
    );

    // Everything else (manifest, sw.js, icons, root html): shorter cache
    app.use(
      express.static(frontendDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );

    // SPA fallback — any GET that isn't an API path and wasn't a static file
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(frontendDir, 'index.html'));
    });
  }

  app.use(errorMiddleware);

  return app;
}
