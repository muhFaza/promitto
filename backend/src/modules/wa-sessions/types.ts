import type { WaStatus } from '../../db/schema.js';

export type { WaStatus };

export type SessionEvent =
  | { type: 'status'; value: WaStatus; jid: string | null; error: string | null }
  | { type: 'qr'; value: string }
  | { type: 'error'; code: string; message: string };

export type WaSnapshot = {
  status: WaStatus;
  jid: string | null;
  lastError: string | null;
};
