import type { UserPublic } from '../lib/types';
import { apiRequest } from './client';

export function list() {
  return apiRequest<{ users: UserPublic[] }>('/api/users');
}

type CreateInput = {
  email: string;
  role: 'user' | 'superuser';
  timezone?: string;
};

export function create(input: CreateInput) {
  return apiRequest<{ user: UserPublic; tempPassword: string }>('/api/users', {
    method: 'POST',
    body: input,
  });
}

export function disable(id: string) {
  return apiRequest<UserPublic>(`/api/users/${id}/disable`, { method: 'PATCH' });
}

export function enable(id: string) {
  return apiRequest<UserPublic>(`/api/users/${id}/enable`, { method: 'PATCH' });
}

export function resetPassword(id: string) {
  return apiRequest<{ user: UserPublic; tempPassword: string }>(
    `/api/users/${id}/reset-password`,
    { method: 'POST' },
  );
}

export function remove(id: string) {
  return apiRequest<void>(`/api/users/${id}`, { method: 'DELETE' });
}
