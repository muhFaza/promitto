import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400 disabled:hover:bg-slate-400',
  secondary:
    'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400 disabled:border-slate-200',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300 disabled:hover:bg-red-300',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'primary', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex min-h-[36px] items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
