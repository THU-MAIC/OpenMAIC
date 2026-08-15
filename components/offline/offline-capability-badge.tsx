import { CircleCheck, CloudOff, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CourseOfflineAudit, OfflineCapability } from '@/lib/offline/course-audit';

const BADGE_STYLES: Record<OfflineCapability, string> = {
  fully:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300',
  basic:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300',
  'requires-network':
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
};

const LABELS: Record<OfflineCapability, string> = {
  fully: '完全离线',
  basic: '基础离线',
  'requires-network': '需要网络',
};

export interface OfflineCapabilityBadgeProps {
  audit: Pick<CourseOfflineAudit, 'capability' | 'label' | 'description'> | OfflineCapability;
  className?: string;
  showDescriptionAsTitle?: boolean;
}

export function OfflineCapabilityBadge({
  audit,
  className,
  showDescriptionAsTitle = true,
}: OfflineCapabilityBadgeProps) {
  const capability = typeof audit === 'string' ? audit : audit.capability;
  const label = typeof audit === 'string' ? LABELS[audit] : audit.label;
  const title = typeof audit === 'string' ? undefined : audit.description;
  const Icon = capability === 'fully' ? CircleCheck : capability === 'basic' ? CloudOff : Wifi;

  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
        BADGE_STYLES[capability],
        className,
      )}
      title={showDescriptionAsTitle ? title : undefined}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}
