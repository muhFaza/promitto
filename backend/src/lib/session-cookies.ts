import type { Response } from 'express';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Clear both auth cookies. Shared by logout and account deletion on purpose:
 * clearCookie only matches a cookie whose path/sameSite/secure attributes agree
 * with the ones it was set with, so two copies of these options drifting apart
 * would leave a live cookie in the browser with nothing behind it.
 */
export function clearSessionCookies(res: Response): void {
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
}
