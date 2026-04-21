import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from '../config/constants.js';
import { readSignedSessionId } from '../lib/cookie-signer.js';
import { setCsrfCookie } from '../lib/csrf.js';
import { errors } from '../lib/errors.js';
import {
  getSessionWithUser,
  touchSession,
} from '../modules/auth/service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const sid = readSignedSessionId(cookies?.[SESSION_COOKIE_NAME]);
    if (!sid) return next(errors.unauthorized());

    const result = getSessionWithUser(sid);
    if (!result) return next(errors.unauthorized());

    const { session, user } = result;
    if (user.disabledAt) return next(errors.unauthorized());

    touchSession(session.id);
    // Slide the CSRF cookie's browser-side maxAge alongside the DB session TTL so
    // a user on continuous sliding TTL doesn't hit silent CSRF 403s on day 30+.
    // Only re-emit on safe methods so we don't mutate response headers on a
    // state-changing request that may already be streaming.
    if (SAFE_METHODS.has(req.method)) setCsrfCookie(res, session.id);
    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSuperuser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(errors.unauthorized());
  if (req.user.role !== 'superuser') return next(errors.forbidden());
  next();
}
