import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err }, 'AppError (5xx)');
    res.status(err.status).json(err.toJSON());
    return;
  }

  if (err instanceof ZodError) {
    const appErr = new AppError('validation_error', 400, 'Validation failed', err.flatten());
    res.status(400).json(appErr.toJSON());
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const fallback = new AppError('internal', 500, 'Internal server error');
  res.status(500).json(fallback.toJSON());
}
