import { create } from 'zustand';
import * as authApi from '../api/auth';
import type { UserPublic } from '../lib/types';
import { useWaStore } from './wa';

type Status = 'idle' | 'loading' | 'authenticated' | 'unauthorized';

type AuthState = {
  user: UserPublic | null;
  status: Status;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  setUser: (u: UserPublic | null) => void;
};

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  status: 'idle',

  async fetchMe() {
    set({ status: 'loading' });
    try {
      const user = await authApi.me();
      set({ user, status: 'authenticated' });
    } catch {
      set({ user: null, status: 'unauthorized' });
    }
  },

  async login(email, password) {
    const user = await authApi.login(email, password);
    set({ user, status: 'authenticated' });
  },

  async logout() {
    try {
      await authApi.logout();
    } finally {
      useWaStore.getState().reset();
      set({ user: null, status: 'unauthorized' });
    }
  },

  setUser(user) {
    set({ user, status: user ? 'authenticated' : 'unauthorized' });
  },
}));
