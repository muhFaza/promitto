import { Router } from 'express';
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { generateTempPassword } from '../../lib/temp-password.js';
import { isValidIanaTimezone } from '../../lib/timezone.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth, requireSuperuser } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { deleteAllSessionsForUser } from '../auth/service.js';
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
