import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ink text-paper-raised hover:bg-ink-soft disabled:bg-ink-muted disabled:hover:bg-ink-muted',
  secondary:
    'bg-paper-raised text-ink border border-rule hover:border-ink hover:bg-paper disabled:text-ink-muted disabled:border-rule',
  danger:
    'bg-accent-warm text-paper-raised hover:brightness-95 disabled:bg-accent-warm-soft disabled:text-ink-muted',
  ghost: 'bg-transparent text-ink-soft hover:bg-paper-deep',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'primary', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex min-h-[38px] items-center justify-center rounded-sm px-4 py-2 text-[13px] font-medium tracking-tight transition-colors duration-150 disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
