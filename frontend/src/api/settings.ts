import type { UserPublic } from '../lib/types';
import { apiRequest } from './client';

export function changePassword(currentPassword: string, newPassword: string) {
  return apiRequest<void>('/api/settings/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

export function changeTimezone(timezone: string) {
  return apiRequest<UserPublic>('/api/settings/timezone', {
    method: 'POST',
    body: { timezone },
  });
}

export function listTimezones() {
  return apiRequest<{ timezones: string[] }>('/api/settings/timezones');
}
