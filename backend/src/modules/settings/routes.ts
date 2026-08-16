import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { verifyPassword } from '../../lib/password.js';
import { clearSessionCookies } from '../../lib/session-cookies.js';
import { isValidIanaTimezone, listTimezones } from '../../lib/timezone.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { deleteAllSessionsForUser } from '../auth/service.js';
import { sweepUser } from '../privacy/retention.js';
import {
  countSuperusers,
  deleteUserById,
  findUserById,
  setContactSyncEnabled,
  setPassword,
  setRetentionDays,
  setTimezone,
} from '../users/service.js';
import { sessionManager } from '../wa-sessions/manager.js';

export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth, requireCsrf);

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12, 'New password must be at least 12 characters').max(1024),
});

settingsRouter.post('/password', async (req, res, next) => {
  try {
    const body = ChangePasswordBody.parse(req.body);
    const user = req.user;
    const session = req.session;
    if (!user || !session) throw errors.unauthorized();

    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw errors.unauthorized('Current password is incorrect');

    await setPassword(user.id, body.newPassword);
    deleteAllSessionsForUser(user.id, session.id);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const ChangeTimezoneBody = z.object({
  timezone: z.string().min(1).max(128),
});

settingsRouter.post('/timezone', requirePasswordRotated, (req, res, next) => {
  try {
    const body = ChangeTimezoneBody.parse(req.body);
    if (!isValidIanaTimezone(body.timezone)) {
      throw errors.badRequest('Invalid IANA timezone');
    }
    if (!req.user) throw errors.unauthorized();
    setTimezone(req.user.id, body.timezone);
    const updated = findUserById(req.user.id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

settingsRouter.get('/timezones', (_req, res) => {
  res.json({ timezones: listTimezones() });
});

// Enumerated rather than a range: these are the only values the UI offers and
// the only ones the copy elsewhere describes. There is deliberately no
// "forever".
const RetentionBody = z.object({
  retentionDays: z.union([
    z.literal(7),
    z.literal(30),
    z.literal(60),
    z.literal(90),
    z.literal(180),
  ]),
});

settingsRouter.post('/retention', requirePasswordRotated, (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = RetentionBody.parse(req.body);
    setRetentionDays(req.user.id, body.retentionDays);
    const updated = findUserById(req.user.id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

const ContactSyncBody = z.object({ enabled: z.boolean() });

settingsRouter.post('/contact-sync', requirePasswordRotated, (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = ContactSyncBody.parse(req.body);
    setContactSyncEnabled(req.user.id, body.enabled);
    const updated = findUserById(req.user.id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

const PurgeBody = z.object({ currentPassword: z.string().min(1).max(1024) });

settingsRouter.post('/purge-data', requirePasswordRotated, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) throw errors.unauthorized();
    const body = PurgeBody.parse(req.body);
    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw errors.unauthorized('Current password is incorrect');

    // retentionDays 0 == cutoff is now == delete everything already past.
    // dryRun is pinned false: RETENTION_DRY_RUN exists to make the periodic
    // sweep observable before it is trusted, and must never turn a user's
    // "delete my data" click into a silent no-op that reports counts anyway.
    const counts = sweepUser(user.id, 0, { dryRun: false });
    logger.info({ userId: user.id, ...counts }, 'user purged their message data');
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

const DeleteAccountBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  confirm: z.literal('DELETE'),
});

settingsRouter.delete('/account', requirePasswordRotated, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) throw errors.unauthorized();
    const body = DeleteAccountBody.parse(req.body);

    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw errors.unauthorized('Current password is incorrect');

    // The last superuser leaving would lock everyone out of user management,
    // and there is no signup path to create a replacement.
    if (user.role === 'superuser' && countSuperusers() <= 1) {
      throw errors.conflict(
        'You are the only superuser. Promote another account before deleting this one.',
      );
    }

    // Unlink the device from the user's phone so they can confirm on their own
    // handset that Promitto is gone. A WhatsApp failure must never block the
    // deletion — the local data still goes.
    try {
      await sessionManager.disconnect(user.id, { logout: true });
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'wa logout failed during account deletion');
    }

    deleteUserById(user.id);
    logger.info({ userId: user.id, email: user.email }, 'account self-deleted');

    // Re-asserted rather than assumed: if the disconnect above threw before
    // wipeAuthState ran, the Baileys creds would otherwise outlive the account
    // they belong to, on disk, with no row left pointing at them.
    await fs.rm(path.join(env.SESSIONS_DIR, user.id), { recursive: true, force: true });

    clearSessionCookies(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
