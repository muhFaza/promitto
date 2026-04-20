import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-paper-deep text-ink-soft border-rule',
  success: 'bg-accent-soft text-accent border-accent/30',
  warning: 'bg-amber-soft-bg text-amber-soft border-amber-soft/40',
  danger: 'bg-accent-warm-soft text-accent-warm border-accent-warm/30',
  info: 'bg-ink text-paper-raised border-ink',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
