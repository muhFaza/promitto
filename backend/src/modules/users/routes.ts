import { Router } from 'express';
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { generateTempPassword } from '../../lib/temp-password.js';
import { isValidIanaTimezone } from '../../lib/timezone.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth, requireSuperuser } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { deleteAllSessionsForUser } from '../auth/service.js';
import { sessionManager } from '../wa-sessions/manager.js';
import {
  createUser,
  deleteUserById,
  findUserByEmailAnyRole,
  findUserById,
  listUsers,
  setDisabledAt,
  setPassword,
} from './service.js';

export const usersRouter: Router = Router();

usersRouter.use(requireAuth, requirePasswordRotated, requireCsrf, requireSuperuser);

const CreateUserBody = z.object({
  email: z.string().email().max(254),
  role: z.enum(['user', 'superuser']),
  timezone: z.string().max(128).optional(),
});

usersRouter.get('/', (_req, res) => {
  res.json({ users: listUsers().map(serializeUser) });
});

usersRouter.post('/', async (req, res, next) => {
  try {
    const body = CreateUserBody.parse(req.body);
    if (body.timezone && !isValidIanaTimezone(body.timezone)) {
      throw errors.badRequest('Invalid IANA timezone');
    }
    if (findUserByEmailAnyRole(body.email)) {
      throw errors.conflict('A user with that email already exists');
    }
    const tempPassword = generateTempPassword();
    const user = await createUser({
      email: body.email,
      role: body.role,
      timezone: body.timezone,
      password: tempPassword,
      mustChangePassword: true,
    });
    res.status(201).json({
      user: serializeUser(user),
      tempPassword,
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/:id/disable', (req, res, next) => {
  try {
    const id = req.params.id;
    const user = findUserById(id);
    if (!user) throw errors.notFound('user');
    if (!req.user) throw errors.unauthorized();
    if (user.id === req.user.id) throw errors.badRequest('You cannot disable yourself');

    setDisabledAt(id, new Date());
    deleteAllSessionsForUser(id);
    const updated = findUserById(id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/:id/enable', (req, res, next) => {
  try {
    const id = req.params.id;
    const user = findUserById(id);
    if (!user) throw errors.notFound('user');
    setDisabledAt(id, null);
    const updated = findUserById(id);
    if (!updated) throw errors.notFound('user');
    res.json(serializeUser(updated));
  } catch (err) {
    next(err);
  }
});

usersRouter.post('/:id/reset-password', async (req, res, next) => {
  try {
    const id = req.params.id;
    const user = findUserById(id);
    if (!user) throw errors.notFound('user');
    if (!req.user) throw errors.unauthorized();
    // Matches the disable/delete self-guards. Without it a lone superuser can
    // reset themselves, which destroys their own session — and the temp
    // password only exists in this response body, which the resulting
    // redirect-to-login can unmount before it is read. Recovery would be
    // SSH-only via cli:reset-superuser-password.
    if (user.id === req.user.id) {
      throw errors.badRequest('Change your own password from Settings instead');
    }

    const tempPassword = generateTempPassword();
    await setPassword(id, tempPassword, { mustChangePassword: true });
    deleteAllSessionsForUser(id);
    const updated = findUserById(id);
    if (!updated) throw errors.notFound('user');

    res.json({
      user: serializeUser(updated),
      tempPassword,
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const user = findUserById(id);
    if (!user) throw errors.notFound('user');
    if (!req.user) throw errors.unauthorized();
    if (user.id === req.user.id) throw errors.badRequest('You cannot delete yourself');

    // Same teardown as the self-delete path in settings/routes.ts, and for the
    // same reasons — an admin-deleted account must not leave more behind than a
    // self-deleted one. Unlink the device so the user's phone stops listing a
    // Promitto session for an account that no longer exists. A WhatsApp failure
    // must never block the deletion; the local data still goes.
    try {
      await sessionManager.disconnect(id, { logout: true });
    } catch (err) {
      logger.warn({ err, userId: id }, 'wa logout failed during admin account deletion');
    }

    // Filesystem BEFORE the DB row — the order is load-bearing, see the long
    // note on the self-delete route. The reverse leaves Baileys credentials on
    // disk with no row pointing at them and nothing that ever prunes them.
    await sessionManager.purgeAuthState(id);

    deleteUserById(id);
    logger.info({ userId: id, email: user.email, by: req.user.id }, 'account deleted by admin');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
