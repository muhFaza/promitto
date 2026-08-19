import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { isValidIanaTimezone } from '../../lib/timezone.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth, requireSuperuser } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { deleteAllSessionsForUser } from '../auth/service.js';
import { issueInvite } from '../invites/service.js';
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

// A password the server generates but never shows anyone. Every account is born
// with one so `password_hash` is NOT NULL and no login can ever succeed against
// it; the real password arrives only when the owner sets it through their
// single-use invite link. The server must never produce a human-readable
// password — not here, not on reset.
function unusablePassword(): string {
  return randomBytes(32).toString('base64url');
}

function inviteResponse(userId: string): { url: string; expiresAt: number } {
  const { token, expiresAt } = issueInvite(userId);
  return { url: `${env.APP_URL}/invite/${token}`, expiresAt: expiresAt.getTime() };
}

usersRouter.post('/', async (req, res, next) => {
  try {
    const body = CreateUserBody.parse(req.body);
    if (body.timezone && !isValidIanaTimezone(body.timezone)) {
      throw errors.badRequest('Invalid IANA timezone');
    }
    if (findUserByEmailAnyRole(body.email)) {
      throw errors.conflict('A user with that email already exists');
    }
    const user = await createUser({
      email: body.email,
      role: body.role,
      timezone: body.timezone,
      password: unusablePassword(),
    });
    // mustChangePassword stays false: the invite IS the rotation gate now, and
    // the account has no usable credential until it is consumed.
    res.status(201).json({
      user: serializeUser(user),
      invite: inviteResponse(user.id),
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
    // reset themselves, which destroys their own session — and the invite link
    // only exists in this response body, which the resulting redirect-to-login
    // can unmount before it is read. Recovery would be SSH-only via
    // cli:reset-superuser-password.
    if (user.id === req.user.id) {
      throw errors.badRequest('Change your own password from Settings instead');
    }

    // Scramble the existing password to something nobody has ever seen, THEN
    // issue the invite. If reset only handed out a link, the old credential
    // would stay live until the link was consumed — so an admin resetting a
    // compromised account would not actually lock the attacker out. Scrambling
    // keeps reset's real semantics (old credential dead immediately) while the
    // new one is set by the owner, never by us.
    await setPassword(id, unusablePassword());
    deleteAllSessionsForUser(id);
    const updated = findUserById(id);
    if (!updated) throw errors.notFound('user');

    res.json({
      user: serializeUser(updated),
      invite: inviteResponse(id),
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete('/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const user = findUserById(id);
    if (!user) throw errors.notFound('user');
    if (!req.user) throw errors.unauthorized();
    if (user.id === req.user.id) throw errors.badRequest('You cannot delete yourself');
    deleteUserById(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
