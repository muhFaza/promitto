import { Router } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { readSignedSessionId, signSessionId } from '../../lib/cookie-signer.js';
import { errors } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth } from '../../middleware/auth.js';
import { loginEmailBucket, loginIpBucket } from './rate-limit.js';
import { createSession, deleteSession, findUserByEmail } from './service.js';

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

    const session = createSession({
      userId: user.id,
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    });

    res.cookie(SESSION_COOKIE_NAME, signSessionId(session.id), {
      httpOnly: true,
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

authRouter.post('/logout', (req, res) => {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const sid = readSignedSessionId(cookies?.[SESSION_COOKIE_NAME]);
  if (sid) deleteSession(sid);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  if (!req.user) throw errors.unauthorized();
  res.json(serializeUser(req.user));
});
