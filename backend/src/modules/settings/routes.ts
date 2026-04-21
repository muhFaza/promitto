import { Router } from 'express';
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { isValidIanaTimezone, listTimezones } from '../../lib/timezone.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { deleteAllSessionsForUser } from '../auth/service.js';
import { findUserById, setPassword, setTimezone } from '../users/service.js';

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

settingsRouter.get('/timezones', requirePasswordRotated, (_req, res) => {
  res.json({ timezones: listTimezones() });
});
