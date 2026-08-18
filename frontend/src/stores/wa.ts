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
  // True once the event stream has given up reconnecting. `status` is then a
  // snapshot from whenever the stream died, not live state — the UI has to say
  // so rather than keep presenting it as current.
  streamStale: boolean;

  fetchStatus: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  logout: () => Promise<void>;
  subscribe: () => () => void;
  reset: () => void;
};

// Module-scoped handle to the active SSE connection, so `reset()` can close it
// without the caller needing to hold the unsub closure.
let activeSseUnsub: (() => void) | null = null;

export const useWaStore = create<WaState>()((set, get) => ({
  status: 'disconnected',
  jid: null,
  lastError: null,
  latestQr: null,
  subscribed: false,
  streamStale: false,

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
    set({ subscribed: true, streamStale: false });
    const unsub = subscribeSse<WaEvent>('/api/wa/events', {
      onOpen: () => set({ streamStale: false }),
      onError: (_err, { willRetry }) => {
        if (willRetry) return;
        // The wrapper has stopped retrying and closed the source, so nothing
        // will update `status` again. Release the subscription slot as well as
        // flagging it — that way a later mount can open a fresh stream instead
        // of being turned away by the `subscribed` guard. The identity check in
        // the unsub closure below keeps this stale one from clobbering it.
        activeSseUnsub = null;
        set({ subscribed: false, streamStale: true });
      },
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
    activeSseUnsub = unsub;
    return () => {
      unsub();
      // Only clear the flag if we're still the live subscription. A stale
      // unmount cleanup firing after a newer subscribe() would otherwise leave
      // subscribed=false alongside a live EventSource, and the next
      // subscribe() would open a second one.
      if (activeSseUnsub === unsub) {
        activeSseUnsub = null;
        set({ subscribed: false });
      }
    };
  },

  reset() {
    if (activeSseUnsub) {
      activeSseUnsub();
      activeSseUnsub = null;
    }
    set({
      status: 'disconnected',
      jid: null,
      lastError: null,
      latestQr: null,
      subscribed: false,
      streamStale: false,
    });
  },
}));
