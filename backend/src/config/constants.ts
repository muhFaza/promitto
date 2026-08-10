export const SESSION_COOKIE_NAME = 'promitto_sid';
export const CSRF_COOKIE_NAME = 'promitto_csrf';
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Ceiling on the sliding window. touchSession() re-extends expiresAt on every
// authenticated request, so without this a stolen cookie kept warm by one
// request a month would never expire.
export const ABSOLUTE_SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const ROLES = ['user', 'superuser'] as const;
export type Role = (typeof ROLES)[number];
