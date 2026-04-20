import { cn } from '../../lib/cn';
import { useUiStore, type ToastLevel } from '../../stores/ui';

const TONES: Record<ToastLevel, string> = {
  info: 'border-slate-200 bg-white text-slate-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-red-200 bg-red-50 text-red-800',
};

export function ToastContainer() {
  const toasts = useUiStore((s) => s.toasts);
  const remove = useUiStore((s) => s.removeToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            'pointer-events-auto rounded-md border px-4 py-3 text-left text-sm shadow-md',
            TONES[t.level],
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
