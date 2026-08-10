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
import { setCsrfCookie } from '../../lib/csrf.js';
import { errors } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { serializeUser } from '../../lib/user.js';
import { requireAuth } from '../../middleware/auth.js';
import { loginEmailBucket, loginIpBucket } from './rate-limit.js';
import {
  createSession,
  deleteExpiredSessionsForUser,
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
    // Login is necessarily CSRF-exempt (no session exists yet). Today a
    // cross-site login-CSRF is blocked only incidentally: express.json() ignores
    // the text/plain body an HTML form can send, and a correct content-type via
    // fetch needs a preflight nothing answers. Assert it explicitly so adding
    // express.urlencoded() later can't silently open login-CSRF, which would
    // sign a victim into the attacker's account and send their scheduled
    // messages from the attacker's paired WhatsApp number.
    if (!req.is('application/json')) {
      throw errors.badRequest('Content-Type must be application/json');
    }
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

    // Multi-device is supported: other live sessions survive a new login. We
    // only reap this user's expired rows, under the same write lock as the
    // insert so concurrent logins can't interleave. Note this gives up
    // "the next login kills a stolen cookie" — the absolute cap in
    // touchSession() (createdAt + ABSOLUTE_SESSION_MAX_MS) is what bounds a
    // leaked session now.
    const session = sqlite.transaction(() => {
      deleteExpiredSessionsForUser(user.id);
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

    setCsrfCookie(res, session.id);

    res.json(serializeUser(user));
  } catch (err) {
    next(err);
  }
});

// Deliberately CSRF-exempt: a missing promitto_csrf cookie (Safari ITP, privacy
// mode) must not strand a live server-side session. requireAuth + the session
// cookie's SameSite=Lax is what makes that safe — a cross-site POST carries no
// cookie and 401s before anything is deleted. Caveat: SameSite is site-scoped,
// and `my.id` is a PSL public suffix, so any future host under muhfaza.my.id
// would be same-site and could force a logout (DoS only — CSRF forgery still
// fails, since the token is HMAC-bound to the victim's session id).
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
