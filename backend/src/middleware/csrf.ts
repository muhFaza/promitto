import type { NextFunction, Request, Response } from 'express';
import { verifyCsrfToken } from '../lib/csrf.js';
import { errors } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.session) return next(errors.unauthorized());

  const header = req.header('X-CSRF-Token');
  if (!verifyCsrfToken(req.session.id, header)) {
    return next(errors.forbidden('Invalid CSRF token'));
  }
  next();
}
