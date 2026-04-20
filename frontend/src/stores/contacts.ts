import { create } from 'zustand';

// Phase 3 wires contact list + search cache here.
type ContactsState = Record<string, never>;

export const useContactsStore = create<ContactsState>()(() => ({}));
