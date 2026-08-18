import { Router } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { sqlite } from '../../db/client.js';
import { signSessionId } from '../../lib/cookie-signer.js';
import { setCsrfCookie } from '../../lib/csrf.js';
import { errors } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { serializeUser } from '../../lib/user.js';
import { createSession, deleteExpiredSessionsForUser } from '../auth/service.js';
import { findUserById } from '../users/service.js';
import { inviteConsumeIpBucket, inviteLookupIpBucket } from './rate-limit.js';
import { consumeInvite, findValidInvite } from './service.js';

// PUBLIC router — deliberately no requireAuth / requirePasswordRotated /
// requireCsrf. Both routes are CSRF-exempt for exactly the reason
// POST /api/auth/login is: no session exists yet, so there is no token to bind
// to. Do NOT add a router.use(requireAuth...) here; that would make every invite
// unusable, which is the one state nobody can recover from without SSH.
export const invitesRouter: Router = Router();

invitesRouter.get('/:token', (req, res, next) => {
  try {
    if (!inviteLookupIpBucket.take(req.ip ?? 'unknown')) {
      throw errors.tooManyRequests('Too many attempts. Try again shortly.');
    }
    const invite = findValidInvite(req.params.token);
    // One 404 for missing, expired, already-consumed and disabled-user alike —
    // an unauthenticated caller learns nothing about which it was.
    if (!invite) throw errors.notFound('invite');
    res.json({ email: invite.email, expiresAt: invite.expiresAt.getTime() });
  } catch (err) {
    next(err);
  }
});

const ConsumeBody = z.object({
  password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
});

invitesRouter.post('/:token', async (req, res, next) => {
  try {
    // Same assertion as POST /api/auth/login, for the same reason: this route
    // signs the caller into an account and is necessarily CSRF-exempt, so a
    // cross-site POST of the attacker's own invite token would otherwise put the
    // victim inside the attacker's account. express.json() ignoring a form's
    // text/plain body is what blocks that today — make it explicit so adding
    // express.urlencoded() later can't silently open it.
    if (!req.is('application/json')) {
      throw errors.badRequest('Content-Type must be application/json');
    }
    if (!inviteConsumeIpBucket.take(req.ip ?? 'unknown')) {
      throw errors.tooManyRequests('Too many attempts. Try again shortly.');
    }
    const body = ConsumeBody.parse(req.body);

    // Cheap validity check before spending an Argon2 hash on a token that was
    // never going to work.
    if (!findValidInvite(req.params.token)) throw errors.notFound('invite');

    const passwordHash = await hashPassword(body.password);
    const consumed = consumeInvite(req.params.token, passwordHash);
    // Lost the race (a concurrent consume, or the invite expired mid-hash).
    if (!consumed) throw errors.notFound('invite');

    const user = findUserById(consumed.userId);
    if (!user) throw errors.notFound('user');

    // Mirrors POST /api/auth/login exactly, including reaping this user's
    // expired session rows under the same write lock as the insert.
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
