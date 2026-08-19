import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

// `/invite/<token>` (SPA navigation) and `/api/invite/<token>` (the XHR behind
// it) both carry a bearer token in the path. Logging it verbatim would put the
// raw token into Docker's json-file logs — 50MB of retained history, well
// beyond the 72h the token is live — and anyone who can read a log could then
// set that account's password. That defeats the whole reason `invites` stores
// only a hash. Link-preview fetchers make this worse: pasting an invite into a
// chat app has its servers GET the URL, so the token lands in the log before
// the human ever opens it.
const INVITE_PATH = /^(\/api)?\/invite\/[^/?]+/;

export function redactUrl(url: string): string {
  return url.replace(INVITE_PATH, (_m, api: string | undefined) => `${api ?? ''}/invite/<redacted>`);
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        method: req.method,
        url: redactUrl(req.originalUrl),
        status: res.statusCode,
        durationMs,
      },
      'request',
    );
  });

  next();
}
