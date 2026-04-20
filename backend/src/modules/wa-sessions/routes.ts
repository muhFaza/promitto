import { Router } from 'express';
import { errors } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { sessionManager } from './manager.js';
import type { SessionEvent } from './types.js';

export const waRouter: Router = Router();
waRouter.use(requireAuth);

waRouter.post('/connect', async (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    await sessionManager.connect(req.user.id);
    res.json(sessionManager.getSnapshot(req.user.id));
  } catch (err) {
    next(err);
  }
});

waRouter.post('/disconnect', async (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    await sessionManager.disconnect(req.user.id, { logout: false });
    res.json(sessionManager.getSnapshot(req.user.id));
  } catch (err) {
    next(err);
  }
});

waRouter.post('/logout', async (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    await sessionManager.disconnect(req.user.id, { logout: true });
    res.json(sessionManager.getSnapshot(req.user.id));
  } catch (err) {
    next(err);
  }
});

waRouter.get('/status', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    res.json(sessionManager.getSnapshot(req.user.id));
  } catch (err) {
    next(err);
  }
});

waRouter.get('/events', (req, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const userId = req.user.id;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const write = (ev: SessionEvent): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const snap = sessionManager.getSnapshot(userId);
  write({ type: 'status', value: snap.status, jid: snap.jid, error: snap.lastError });
  const qr = sessionManager.getLatestQr(userId);
  if (qr) write({ type: 'qr', value: qr });

  const unsubscribe = sessionManager.subscribe(userId, write);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 30_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
});
