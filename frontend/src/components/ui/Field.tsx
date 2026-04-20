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
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
