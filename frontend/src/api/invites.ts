import type { UserPublic } from '../lib/types';
import { apiRequest } from './client';

export type Invite = {
  email: string;
  expiresAt: number;
};

/** Public — 404s if the token is unknown, expired, or already used. */
export function lookup(token: string) {
  return apiRequest<Invite>(`/api/invite/${encodeURIComponent(token)}`);
}

/** Consumes the invite and logs the invitee in; cookies are set by the response. */
export function consume(token: string, password: string) {
  return apiRequest<UserPublic>(`/api/invite/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: { password },
  });
}
