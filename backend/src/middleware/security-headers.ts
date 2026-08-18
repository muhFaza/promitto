import type { NextFunction, Request, Response } from 'express';

// Set on every response, API and static alike. HSTS is deliberately absent: it
// belongs where TLS terminates, and Traefik already applies it.
//
// img-src is the one loose directive, and it is loose on purpose.
// GET /api/contacts/:id/avatar 302s to whatever host Baileys hands back for a
// WhatsApp profile picture (pps.whatsapp.net today, Meta CDN hosts at other
// times). Pinning that to a literal origin means avatars vanish silently the
// day WhatsApp moves them, so this allows any https image instead — the
// redirect target is already validated as https in contacts/routes.ts, and the
// XSS protection CSP actually buys here comes from script-src / object-src /
// base-uri, which is also all Lighthouse's CSP-XSS audit grades. Tighten it to
// the real host if you ever confirm one.
//
// style-src needs 'unsafe-inline' because React writes inline style props
// (animationDelay). script-src does NOT: the Vite build emits no inline
// <script> at all, so 'self' alone is enough.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}
