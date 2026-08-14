import { create } from 'zustand';
import * as contactsApi from '../api/contacts';
import type { Contact } from '../lib/types';

// Rows, not chips — six keeps the compose section from turning into a list page.
const RECENT_LIMIT = 6;

type ContactsState = {
  recent: Contact[];
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
};

// Shared so a fresh send from compose reorders the Dashboard quick-pick
// without a manual refetch there.
export const useContactsStore = create<ContactsState>()((set) => ({
  recent: [],
  loaded: false,

  async load() {
    try {
      const r = await contactsApi.recent(RECENT_LIMIT);
      set({ recent: r.contacts, loaded: true });
    } catch {
      // The quick-pick list is an accelerator, not a control — a failed fetch
      // hides it and leaves the picker to do the work. No toast.
      set({ loaded: true });
    }
  },

  // `loaded` latches, and logout is an SPA transition with no reload anywhere —
  // without this the next user in the same tab sees the previous one's contacts.
  reset() {
    set({ recent: [], loaded: false });
  },
}));
