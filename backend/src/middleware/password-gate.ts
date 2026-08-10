import type { NextFunction, Request, Response } from 'express';
import { errors } from '../lib/errors.js';

export function requirePasswordRotated(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) return next(errors.unauthorized());
  if (req.user.mustChangePassword) return next(errors.mustChangePassword());
  next();
}
