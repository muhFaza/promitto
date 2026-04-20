import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'block w-full rounded-sm border border-rule bg-paper-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted transition-colors focus:border-ink focus:outline-none disabled:bg-paper-deep disabled:text-ink-muted',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
