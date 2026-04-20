import type { WaStatus } from '../api/wa';
import { cn } from '../lib/cn';

type Tone = 'live' | 'pending' | 'idle' | 'danger';

type Meta = { label: string; tone: Tone };

const META: Record<WaStatus, Meta> = {
  connected: { label: 'Live', tone: 'live' },
  connecting: { label: 'Linking', tone: 'pending' },
  qr_pending: { label: 'Scan QR', tone: 'pending' },
  disconnected: { label: 'Idle', tone: 'idle' },
  logged_out: { label: 'Logged out', tone: 'idle' },
  failed: { label: 'Failed', tone: 'danger' },
};

const DOT: Record<Tone, string> = {
  live: 'bg-accent',
  pending: 'bg-amber-soft',
  idle: 'bg-ink-muted',
  danger: 'bg-accent-warm',
};

const TEXT: Record<Tone, string> = {
  live: 'text-accent',
  pending: 'text-amber-soft',
  idle: 'text-ink-muted',
  danger: 'text-accent-warm',
};

type DotProps = { status: WaStatus; size?: 'sm' | 'md' };

export function WaStatusDot({ status, size = 'sm' }: DotProps) {
  const tone = META[status].tone;
  const dim = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const pulse = tone === 'pending' || tone === 'live';
  return (
    <span className={cn('relative inline-flex', dim)} aria-hidden>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-50',
            DOT[tone],
          )}
        />
      )}
      <span className={cn('relative inline-flex rounded-full', dim, DOT[tone])} />
    </span>
  );
}

type LabelProps = { status: WaStatus; className?: string };

export function WaStatusLabel({ status, className }: LabelProps) {
  const { label, tone } = META[status];
  return (
    <span
      className={cn(
        'text-[10px] font-medium uppercase tracking-wide',
        TEXT[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
