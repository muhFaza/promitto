import compression from 'compression';
import cookieParser from 'cookie-parser';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { sqlite } from './db/client.js';
import { memorySnapshot } from './lib/memory-monitor.js';
import { errorMiddleware } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { authRouter } from './modules/auth/routes.js';
import { contactsRouter } from './modules/contacts/routes.js';
import { schedulerRouter } from './modules/scheduler/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { sessionManager } from './modules/wa-sessions/manager.js';
import { waRouter } from './modules/wa-sessions/routes.js';
import { countRestorable } from './modules/wa-sessions/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Drops `br` from the client's Accept-Encoding so `compression` negotiates gzip.
 *
 * compression@1.8 prefers brotli over gzip whenever the client offers it, and
 * that is the wrong trade on this box in both directions at once. Measured on
 * the real bundle: brotli at compression's default quality (4) emitted
 * 103,333 bytes against gzip's 102,674 — *larger* — while allocating a
 * multi-megabyte window per concurrent stream. Those buffers live outside the
 * V8 heap, so --max-old-space-size does not bound them; they land straight
 * against the container's 384MB mem_limit, on a host that has OOM-killed Node
 * before. Turning brotli's quality up would win the bytes back, but the memory
 * it costs is the one resource here we have none of.
 *
 * If a client somehow offers only `br`, it ends up with an uncompressed
 * response, which is correct — better than claiming an encoding it did not ask
 * for. Every real browser also offers gzip.
 */
function preferGzip(req: Request, _res: Response, next: NextFunction): void {
  const accepted = req.headers['accept-encoding'];
  if (typeof accepted !== 'string' || !accepted.includes('br')) return next();

  const remaining = accepted
    .split(',')
    .filter((token) => !/^\s*br\s*(?:;|$)/i.test(token))
    .join(',')
    .trim();

  req.headers['accept-encoding'] = remaining === '' ? 'identity' : remaining;
  next();
}

export function createApp(): Express {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestLogger);

  // Must sit above everything it should compress — `compression` works by
  // wrapping res.write/res.end, so anything registered earlier escapes it.
  // Placed after requestLogger so timing still measures the whole response.
  //
  // This covers the API routers too, not just the static mounts, and that is the
  // point: /assets is immutable, so after a first visit the only bytes still
  // crossing the wire are /api/scheduler and /api/contacts JSON.
  //
  // gzip, deliberately — see preferGzip above for the measurements.
  //
  // The SSE stream at /api/wa/events is safe: it sets Cache-Control no-transform
  // (wa-sessions/routes.ts), which compression honours by skipping the response.
  // Without that it would buffer, and WhatsApp pairing would hang with no QR.
  app.use(preferGzip);
  app.use(compression({ threshold: 1024 }));

  app.use(securityHeaders);
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

    // Everything else (manifest, sw.js, icons, robots.txt, root html).
    // index.html and sw.js must revalidate every time — they are how a new
    // deploy is discovered at all. The rest are unhashed but effectively static,
    // so a day of caching saves re-fetching them on every visit.
    app.use(
      express.static(frontendDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
          }
        },
      }),
    );

    // SPA fallback — any GET/HEAD that isn't an API path and wasn't a static file.
    //
    // HEAD is handled because express.static answers it but this fallback used
    // not to, so HEAD /app 404'd while GET /app was fine — enough to make an
    // uptime monitor report the site down. res.sendFile sends headers only.
    //
    // Paths whose last segment contains a dot are refused rather than answered
    // with index.html. A request for a *file* that got this far is a file that
    // does not exist, and handing back 200 + HTML made /robots.txt parse as 26
    // broken directives, and made every /.env probe look like a hit.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/')) return next();
      if (req.path.split('/').pop()?.includes('.')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(frontendDir, 'index.html'));
    });
  }

  app.use(errorMiddleware);

  return app;
}
