import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { sqlite } from './db/client.js';
import { errorMiddleware } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { authRouter } from './modules/auth/routes.js';
import { contactsRouter } from './modules/contacts/routes.js';
import { schedulerRouter } from './modules/scheduler/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { sessionManager } from './modules/wa-sessions/manager.js';
import { waRouter } from './modules/wa-sessions/routes.js';

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
    res.json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      sessions: sessionManager.getConnectedCount(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
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
