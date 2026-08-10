import { cn } from '../../lib/cn';
import { useUiStore, type ToastLevel } from '../../stores/ui';

const TONES: Record<ToastLevel, string> = {
  info: 'border-rule bg-paper-raised text-ink',
  success: 'border-accent/40 bg-paper-raised text-accent',
  error: 'border-accent-warm/40 bg-paper-raised text-accent-warm',
};

export function ToastContainer() {
  const toasts = useUiStore((s) => s.toasts);
  const remove = useUiStore((s) => s.removeToast);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            'pointer-events-auto border px-4 py-3 text-left text-sm',
            TONES[t.level],
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
