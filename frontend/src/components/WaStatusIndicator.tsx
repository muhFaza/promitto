import type { WaStatus } from '../api/wa';
import { cn } from '../lib/cn';

type Tone = 'live' | 'pending' | 'idle' | 'danger';

type Meta = { label: string; tone: Tone };

const META: Record<WaStatus, Meta> = {
  connected: { label: 'Connected', tone: 'live' },
  connecting: { label: 'Connecting', tone: 'pending' },
  qr_pending: { label: 'Scan QR', tone: 'pending' },
  disconnected: { label: 'Disconnected', tone: 'idle' },
  logged_out: { label: 'Logged out', tone: 'idle' },
  failed: { label: 'Failed', tone: 'danger' },
};

const DOT: Record<Tone, string> = {
  live: 'bg-emerald-500',
  pending: 'bg-amber-500',
  idle: 'bg-slate-400',
  danger: 'bg-red-500',
};

const TEXT: Record<Tone, string> = {
  live: 'text-emerald-700',
  pending: 'text-amber-700',
  idle: 'text-slate-600',
  danger: 'text-red-700',
};

type DotProps = { status: WaStatus; size?: 'sm' | 'md' };

export function WaStatusDot({ status, size = 'sm' }: DotProps) {
  const tone = META[status].tone;
  const dim = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const pulse = tone === 'pending';
  return (
    <span className={cn('relative inline-flex', dim)} aria-hidden>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            DOT[tone],
          )}
        />
      )}
      <span
        className={cn('relative inline-flex rounded-full', dim, DOT[tone])}
      />
    </span>
  );
}

type LabelProps = { status: WaStatus; className?: string };

export function WaStatusLabel({ status, className }: LabelProps) {
  const { label, tone } = META[status];
  return <span className={cn('font-medium', TEXT[tone], className)}>{label}</span>;
}
