'use client';

import { Database, HardDrive, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatStorageBytes } from '@/lib/offline/storage';
import { useStorageStatus } from './use-storage-status';

export interface StorageStatusCardProps {
  className?: string;
  compact?: boolean;
}

export function StorageStatusCard({ className, compact = false }: StorageStatusCardProps) {
  const { snapshot, loading, requestingPersistence, error, requestPersistence } =
    useStorageStatus();
  const percent = Math.round((snapshot?.usageRatio ?? 0) * 100);

  return (
    <section
      aria-labelledby="offline-storage-title"
      className={cn(
        'rounded-2xl border border-violet-100 bg-white p-4 shadow-sm dark:border-violet-950 dark:bg-card',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            <Database aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 id="offline-storage-title" className="text-sm font-semibold">
              本地课程存储
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {loading
                ? '正在读取存储空间…'
                : snapshot?.supported
                  ? `已使用 ${formatStorageBytes(snapshot.usage)}，可用约 ${formatStorageBytes(snapshot.available)}`
                  : '当前浏览器不支持存储空间查询'}
            </p>
          </div>
        </div>
        {snapshot?.persisted ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <ShieldCheck aria-hidden="true" className="size-3" />
            已受保护
          </span>
        ) : null}
      </div>

      {!compact && snapshot?.supported && snapshot.quota > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>浏览器空间占用</span>
            <span>{percent}%</span>
          </div>
          <Progress value={percent} aria-label={`本地存储已使用 ${percent}%`} />
        </div>
      ) : null}

      {!snapshot?.persisted && snapshot?.persistenceSupported ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-violet-50/70 p-3 dark:bg-violet-950/40">
          <div className="flex min-w-0 items-center gap-2 text-xs text-violet-900 dark:text-violet-200">
            <HardDrive aria-hidden="true" className="size-4 shrink-0" />
            <span>保护课程，避免浏览器在空间不足时自动清理</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 bg-white dark:bg-background"
            disabled={requestingPersistence}
            onClick={() => void requestPersistence()}
          >
            {requestingPersistence ? '申请中…' : '保护数据'}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
