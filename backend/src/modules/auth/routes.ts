import { Router } from 'express';
import { z } from 'zod';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
} from '../../config/constants.js';
import { env } from '../../config/env.js';
import { sqlite } from '../../db/client.js';
import { signSessionId } from '../../lib/cookie-signer.js';
import { computeCsrfToken } from '../../lib/csrf.js';
import { errors } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth } from '../../middleware/auth.js';
import { loginEmailBucket, loginIpBucket } from './rate-limit.js';
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSession,
  findUserByEmail,
} from './service.js';

export const authRouter: Router = Router();

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const ip = req.ip ?? 'unknown';
    const emailKey = body.email.trim().toLowerCase();

    if (!loginIpBucket.take(ip) || !loginEmailBucket.take(emailKey)) {
      throw errors.tooManyRequests('Too many login attempts. Try again shortly.');
    }

    const user = findUserByEmail(body.email);
    const ok =
      user && !user.disabledAt
        ? await verifyPassword(user.passwordHash, body.password)
        : false;

    if (!user || user.disabledAt || !ok) {
      throw errors.unauthorized('Invalid email or password');
    }

    // Atomic: revoke prior sessions and mint the new one under a single write lock so
    // concurrent logins cannot leave multiple live sessions.
    const session = sqlite.transaction(() => {
      deleteAllSessionsForUser(user.id);
      return createSession({
        userId: user.id,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      });
    }).immediate();

    res.cookie(SESSION_COOKIE_NAME, signSessionId(session.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_DURATION_MS,
    });

    res.cookie(CSRF_COOKIE_NAME, computeCsrfToken(session.id), {
      httpOnly: false,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_DURATION_MS,
    });

    res.json(serializeUser(user));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', requireAuth, (req, res) => {
  if (req.session) deleteSession(req.session.id);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  });
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  if (!req.user) throw errors.unauthorized();
  res.json(serializeUser(req.user));
});
