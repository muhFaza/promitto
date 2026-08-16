import { create } from 'zustand';
import * as contactsApi from '../api/contacts';
import type { Contact } from '../lib/types';

// Rows, not chips — six keeps the compose section from turning into a list page.
// "Show more" adds another six each press, up to a ceiling the server will
// still accept (`/contacts/recent` rejects limit > 50 outright).
const RECENT_PAGE = 6;
const RECENT_MAX = 48;

type ContactsState = {
  recent: Contact[];
  loaded: boolean;
  // The page size currently in force. `load()` reuses it, so refetching after a
  // send — or coming back to the Dashboard — keeps an expanded list expanded.
  limit: number;
  hasMore: boolean;
  loadingMore: boolean;
  load: () => Promise<void>;
  showMore: () => Promise<void>;
  reset: () => void;
};

// A short page that comes back full is the only "more exist" signal the
// endpoint gives us — it returns rows, not a total.
function moreLikely(returned: number, limit: number): boolean {
  return returned === limit && limit < RECENT_MAX;
}

// Shared so a fresh send from compose reorders the Dashboard quick-pick
// without a manual refetch there.
export const useContactsStore = create<ContactsState>()((set, get) => ({
  recent: [],
  loaded: false,
  limit: RECENT_PAGE,
  hasMore: false,
  loadingMore: false,

  async load() {
    const { limit } = get();
    try {
      const r = await contactsApi.recent(limit);
      set({
        recent: r.contacts,
        loaded: true,
        hasMore: moreLikely(r.contacts.length, limit),
      });
    } catch {
      // The quick-pick list is an accelerator, not a control — a failed fetch
      // hides it and leaves the picker to do the work. No toast.
      set({ loaded: true });
    }
  },

  async showMore() {
    const { limit, loadingMore, hasMore } = get();
    if (loadingMore || !hasMore) return;
    const next = Math.min(limit + RECENT_PAGE, RECENT_MAX);
    set({ loadingMore: true });
    try {
      const r = await contactsApi.recent(next);
      set({
        recent: r.contacts,
        limit: next,
        hasMore: moreLikely(r.contacts.length, next),
        loadingMore: false,
      });
    } catch {
      // Same accelerator logic: leave the rows already on screen alone and keep
      // `limit` where it was, so pressing again retries the same page.
      set({ loadingMore: false });
    }
  },

  // `loaded` latches, and logout is an SPA transition with no reload anywhere —
  // without this the next user in the same tab sees the previous one's contacts.
  reset() {
    set({
      recent: [],
      loaded: false,
      limit: RECENT_PAGE,
      hasMore: false,
      loadingMore: false,
    });
  },
}));
