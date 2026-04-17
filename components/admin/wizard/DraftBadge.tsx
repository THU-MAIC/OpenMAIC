import { cn } from '@/lib/utils';

interface DraftBadgeProps {
  hasUnsavedChanges: boolean;
}

export function DraftBadge({ hasUnsavedChanges }: DraftBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        hasUnsavedChanges ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300',
      )}
    >
      {hasUnsavedChanges ? 'Draft has unsaved changes' : 'Draft saved'}
    </span>
  );
}
