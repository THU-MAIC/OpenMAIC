import { AlertTriangle, CheckCircle2, Info, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CourseOfflineAudit } from '@/lib/offline/course-audit';
import { OfflineCapabilityBadge } from './offline-capability-badge';

export interface OfflineAuditSummaryProps {
  audit: CourseOfflineAudit;
  className?: string;
  maxIssues?: number;
}

export function OfflineAuditSummary({ audit, className, maxIssues = 4 }: OfflineAuditSummaryProps) {
  const visibleIssues = audit.issues.slice(0, Math.max(0, maxIssues));

  return (
    <section
      aria-labelledby="offline-audit-title"
      className={cn('rounded-2xl border bg-card p-4', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="offline-audit-title" className="text-sm font-semibold">
            离线可用性
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{audit.description}</p>
        </div>
        <OfflineCapabilityBadge audit={audit} />
      </div>

      {visibleIssues.length ? (
        <ul className="mt-4 space-y-2">
          {visibleIssues.map((issue, index) => {
            const Icon =
              issue.severity === 'blocking'
                ? AlertTriangle
                : issue.severity === 'degraded'
                  ? Info
                  : Link2;
            return (
              <li key={`${issue.code}-${issue.path}-${index}`} className="flex gap-2 text-xs">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    issue.severity === 'blocking' ? 'text-amber-600' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0 break-words leading-5 text-muted-foreground">
                  {issue.sceneTitle ? `${issue.sceneTitle}：` : ''}
                  {issue.message}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
          <CheckCircle2 aria-hidden="true" className="size-4" />
          未发现外部资源依赖
        </div>
      )}

      {audit.issues.length > visibleIssues.length ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          另有 {audit.issues.length - visibleIssues.length} 项检查结果
        </p>
      ) : null}
    </section>
  );
}
