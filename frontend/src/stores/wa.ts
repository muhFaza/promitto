import { create } from 'zustand';
import { subscribeSse } from '../api/sse';
import * as waApi from '../api/wa';
import type { WaEvent, WaStatus } from '../api/wa';

type WaState = {
  status: WaStatus;
  jid: string | null;
  lastError: string | null;
  latestQr: string | null;
  subscribed: boolean;

  fetchStatus: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  logout: () => Promise<void>;
  subscribe: () => () => void;
};

export const useWaStore = create<WaState>()((set, get) => ({
  status: 'disconnected',
  jid: null,
  lastError: null,
  latestQr: null,
  subscribed: false,

  async fetchStatus() {
    const snap = await waApi.getStatus();
    set({ status: snap.status, jid: snap.jid, lastError: snap.lastError });
  },

  async connect() {
    const snap = await waApi.connect();
    set({ status: snap.status, jid: snap.jid, lastError: snap.lastError });
  },

  async disconnect() {
    const snap = await waApi.disconnect();
    set({
      status: snap.status,
      jid: snap.jid,
      lastError: snap.lastError,
      latestQr: null,
    });
  },

  async logout() {
    const snap = await waApi.logout();
    set({
      status: snap.status,
      jid: snap.jid,
      lastError: snap.lastError,
      latestQr: null,
    });
  },

  subscribe() {
    if (get().subscribed) return () => {};
    set({ subscribed: true });
    const unsub = subscribeSse<WaEvent>('/api/wa/events', {
      onMessage: (ev) => {
        if (ev.type === 'status') {
          set({
            status: ev.value,
            jid: ev.jid,
            lastError: ev.error,
            ...(ev.value !== 'qr_pending' && ev.value !== 'connecting'
              ? { latestQr: null }
              : {}),
          });
        } else if (ev.type === 'qr') {
          set({ latestQr: ev.value });
        }
      },
    });
    return () => {
      unsub();
      set({ subscribed: false });
    };
  },
}));
