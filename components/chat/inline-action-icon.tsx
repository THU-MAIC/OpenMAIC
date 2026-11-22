import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InlineActionIconProps {
  icon: LucideIcon;
  style: string;
  title?: string;
}

export function InlineActionIcon({ icon: Icon, style, title }: InlineActionIconProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center w-4 h-4 rounded-full border align-middle mr-0.5',
        style,
      )}
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
    >
      <Icon className="w-2.5 h-2.5" aria-hidden="true" />
    </span>
  );
}
