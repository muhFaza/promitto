import { create } from 'zustand';

export type ToastLevel = 'info' | 'success' | 'error';

export type Toast = {
  id: string;
  message: string;
  level: ToastLevel;
};

type UiState = {
  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
};

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  pushToast: (t) => {
    const id = Math.random().toString(36).slice(2, 10);
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    setTimeout(() => {
      if (get().toasts.some((x) => x.id === id)) {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }
    }, 5000);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
