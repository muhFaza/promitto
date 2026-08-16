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

export function setRetention(retentionDays: number) {
  return apiRequest<UserPublic>('/api/settings/retention', {
    method: 'POST',
    body: { retentionDays },
  });
}

export function setContactSync(enabled: boolean) {
  return apiRequest<UserPublic>('/api/settings/contact-sync', {
    method: 'POST',
    body: { enabled },
  });
}

export function purgeData(currentPassword: string) {
  return apiRequest<{ sentMessages: number; scheduledMessages: number }>(
    '/api/settings/purge-data',
    { method: 'POST', body: { currentPassword } },
  );
}

export function deleteAccount(currentPassword: string) {
  return apiRequest<void>('/api/settings/account', {
    method: 'DELETE',
    body: { currentPassword, confirm: 'DELETE' },
  });
}
