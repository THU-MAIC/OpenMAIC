'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Atom, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

type InteractiveModeButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'aria-pressed' | 'children'
> &
  DataAttributes & {
    pressed: boolean;
    label: string;
    onPressedChange: (pressed: boolean) => void;
  };

export const InteractiveModeButton = forwardRef<HTMLButtonElement, InteractiveModeButtonProps>(
  function InteractiveModeButton(
    { pressed, label, onPressedChange, className, onClick, ...buttonProps },
    ref,
  ) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-pressed={pressed}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onPressedChange(!pressed);
        }}
        className={cn(
          'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 motion-reduce:transition-none motion-reduce:active:scale-100 dark:focus-visible:outline-cyan-300',
          pressed
            ? 'border-cyan-400 bg-cyan-100 text-cyan-900 shadow-sm shadow-cyan-200/60 dark:border-cyan-200 dark:bg-cyan-400 dark:text-slate-950 dark:shadow-[0_0_18px_rgba(34,211,238,0.45)]'
            : 'border-cyan-600 bg-transparent text-cyan-700 hover:bg-cyan-50 dark:border-cyan-700 dark:text-cyan-300 dark:hover:bg-cyan-950/50',
          className,
        )}
      >
        {pressed && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[-4px] rounded-full border border-cyan-300/40 dark:border-cyan-300/60 motion-safe:dark:animate-[interactive-mode-breathe_2s_ease-in-out_infinite]"
          />
        )}
        {pressed ? (
          <Check aria-hidden="true" className="relative z-10 size-3.5" />
        ) : (
          <Atom aria-hidden="true" className="relative z-10 size-3.5" />
        )}
        <span className="relative z-10">{label}</span>
      </button>
    );
  },
);
