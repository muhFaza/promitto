import type { Contact } from '../lib/types';
import { apiRequest } from './client';

export function list(params: { search?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<{ contacts: Contact[] }>(`/api/contacts${suffix}`);
}

export function create(input: { phone: string; displayName: string }) {
  return apiRequest<Contact>('/api/contacts', { method: 'POST', body: input });
}

export function rename(id: string, displayName: string) {
  return apiRequest<Contact>(`/api/contacts/${id}`, {
    method: 'PATCH',
    body: { displayName },
  });
}

export function remove(id: string) {
  return apiRequest<void>(`/api/contacts/${id}`, { method: 'DELETE' });
}
