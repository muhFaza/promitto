import type { UserPublic } from '../lib/types';
import { apiRequest } from './client';

export function login(email: string, password: string) {
  return apiRequest<UserPublic>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

export function logout() {
  return apiRequest<void>('/api/auth/logout', { method: 'POST' });
}

export function me() {
  return apiRequest<UserPublic>('/api/auth/me');
}
