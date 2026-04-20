import type { ReactNode } from 'react';

type Props = {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
};

export function Field({ label, error, hint, children }: Props) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
      {error && (
        <span className="mt-1.5 block text-[12px] text-accent-warm">
          {error}
        </span>
      )}
      {hint && !error && (
        <span className="mt-1.5 block text-[12px] text-ink-muted">
          {hint}
        </span>
      )}
    </label>
  );
}
