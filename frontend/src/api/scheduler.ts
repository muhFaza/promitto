import type { ScheduledMessage, SentMessage } from '../lib/types';
import { apiRequest } from './client';

export type TabStatus = 'upcoming' | 'recurring' | 'history' | 'failed';

type CreateInput = {
  recipientJid: string;
  messageText: string;
  scheduleType: 'once' | 'recurring';
  nextRunAt?: number;
  cronExpression?: string;
  timezone?: string;
};

export function create(input: CreateInput) {
  return apiRequest<ScheduledMessage>('/api/scheduler', {
    method: 'POST',
    body: input,
  });
}

export function list(status: TabStatus) {
  return apiRequest<
    | { items: ScheduledMessage[]; kind: 'scheduled' }
    | { items: SentMessage[]; kind: 'sent' }
  >(`/api/scheduler?status=${status}`);
}

export function cancel(id: string) {
  return apiRequest<void>(`/api/scheduler/${id}`, { method: 'DELETE' });
}

export function update(id: string, input: Partial<CreateInput>) {
  return apiRequest<ScheduledMessage>(`/api/scheduler/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function stats() {
  return apiRequest<{ pendingCount: number }>('/api/scheduler/stats');
}

export function preview(cronExpression: string, timezone: string, count = 5) {
  return apiRequest<{ runs: number[] }>('/api/scheduler/preview', {
    method: 'POST',
    body: { cronExpression, timezone, count },
  });
}
