export const SESSION_COOKIE_NAME = 'promitto_sid';
export const CSRF_COOKIE_NAME = 'promitto_csrf';
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const ROLES = ['user', 'superuser'] as const;
export type Role = (typeof ROLES)[number];
