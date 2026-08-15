'use client';

import { CloudOff, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNetworkStatus } from './use-network-status';

export interface NetworkStatusBadgeProps {
  className?: string;
  showConnectionType?: boolean;
  onlineLabel?: string;
  offlineLabel?: string;
}

export function NetworkStatusBadge({
  className,
  showConnectionType = false,
  onlineLabel = '网络正常',
  offlineLabel = '离线模式',
}: NetworkStatusBadgeProps) {
  const status = useNetworkStatus();
  const detail = showConnectionType && status.online ? status.effectiveType : undefined;

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
        status.online
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
        className,
      )}
      title={
        status.online
          ? '联网功能可用；已下载的课程也可以离线打开'
          : '已切换到离线状态；本地课程仍可继续使用'
      }
    >
      {status.online ? (
        <Wifi aria-hidden="true" className="size-3.5" />
      ) : (
        <CloudOff aria-hidden="true" className="size-3.5" />
      )}
      <span>{status.online ? onlineLabel : offlineLabel}</span>
      {detail ? <span className="uppercase opacity-60">· {detail}</span> : null}
    </span>
  );
}
