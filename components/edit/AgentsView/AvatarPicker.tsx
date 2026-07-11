'use client';

import { cn } from '@/lib/utils';
import { AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

interface AvatarPickerProps {
  readonly value: string;
  readonly onChange: (avatar: string) => void;
}

/**
 * A grid picker that lets the user choose one of the built-in agent avatars.
 */
export function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {AGENT_DEFAULT_AVATARS.map((src) => (
        <button
          key={src}
          type="button"
          aria-label={src}
          onClick={() => onChange(src)}
          className={cn(
            'flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border-2 transition-all',
            value === src
              ? 'border-violet-500 shadow-[0_0_0_3px_rgba(139,92,246,0.18)]'
              : 'border-transparent hover:border-zinc-300 dark:hover:border-zinc-600',
          )}
        >
          <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        </button>
      ))}
    </div>
  );
}
