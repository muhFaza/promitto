import { create } from 'zustand';
import * as contactsApi from '../api/contacts';
import type { Contact } from '../lib/types';

const RECENT_LIMIT = 8;

type ContactsState = {
  recent: Contact[];
  loaded: boolean;
  load: () => Promise<void>;
  togglePin: (c: Contact) => Promise<void>;
  reset: () => void;
};

// Shared so pinning on /app/contacts reorders the Dashboard quick-pick row
// without a manual refetch there.
export const useContactsStore = create<ContactsState>()((set, get) => ({
  recent: [],
  loaded: false,

  async load() {
    try {
      const r = await contactsApi.recent(RECENT_LIMIT);
      set({ recent: r.contacts, loaded: true });
    } catch {
      // The quick-pick row is an accelerator, not a control — a failed fetch
      // hides it and leaves the picker to do the work. No toast.
      set({ loaded: true });
    }
  },

  async togglePin(c) {
    // ApiError propagates: the caller owns the error surface.
    await contactsApi.setPinned(c.id, c.pinnedAt === null);
    await get().load();
  },

  // `loaded` latches, and logout is an SPA transition with no reload anywhere —
  // without this the next user in the same tab sees the previous one's contacts.
  reset() {
    set({ recent: [], loaded: false });
  },
}));
