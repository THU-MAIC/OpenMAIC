'use client';

import { cn } from '@/lib/utils/cn';
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
            'flex size-12 items-center justify-center overflow-hidden rounded-xl border-2 transition-all',
            value === src
              ? 'border-primary shadow-[0_0_0_3px_rgba(114,46,209,0.18)]'
              : 'border-transparent hover:border-border',
          )}
        >
          {/* Static public path — no image optimizer needed. */}
          <img src={src} alt="" className="size-full object-cover" draggable={false} />
        </button>
      ))}
    </div>
  );
}
