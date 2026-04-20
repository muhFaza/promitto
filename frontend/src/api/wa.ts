import { apiRequest } from './client';

export type WaStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'connected'
  | 'logged_out'
  | 'failed';

export type WaSnapshot = {
  status: WaStatus;
  jid: string | null;
  lastError: string | null;
};

export type WaEvent =
  | { type: 'status'; value: WaStatus; jid: string | null; error: string | null }
  | { type: 'qr'; value: string }
  | { type: 'error'; code: string; message: string };

export function getStatus() {
  return apiRequest<WaSnapshot>('/api/wa/status');
}

export function connect() {
  return apiRequest<WaSnapshot>('/api/wa/connect', { method: 'POST' });
}

export function disconnect() {
  return apiRequest<WaSnapshot>('/api/wa/disconnect', { method: 'POST' });
}

export function logout() {
  return apiRequest<WaSnapshot>('/api/wa/logout', { method: 'POST' });
}
