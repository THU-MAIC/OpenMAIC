'use client';

import type { PBLIssueboard, PBLIssue } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';

interface IssueboardPanelProps {
  readonly issueboard: PBLIssueboard;
}

export function IssueboardPanel({ issueboard }: IssueboardPanelProps) {
  const { t } = useI18n();
  const sortedIssues = [...issueboard.issues].sort((a, b) => a.index - b.index);

  const doneCount = sortedIssues.filter((i) => i.is_done).length;
  const totalCount = sortedIssues.length;
  const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b">
        <h2 className="font-semibold text-sm">{t('pbl.issueboard.title')}</h2>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {doneCount}/{totalCount}
          </span>
        </div>
      </div>

      {/* Issue List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {sortedIssues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} />
        ))}
        {sortedIssues.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t('pbl.issueboard.noIssues')}
          </p>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: PBLIssue }) {
  const { t } = useI18n();
  const statusColor = issue.is_done
    ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20'
    : issue.is_active
      ? 'border-primary bg-primary/5'
      : 'border-muted';

  const statusLabel = issue.is_done
    ? t('pbl.issueboard.statusDone')
    : issue.is_active
      ? t('pbl.issueboard.statusActive')
      : t('pbl.issueboard.statusPending');

  const statusBadgeColor = issue.is_done
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    : issue.is_active
      ? 'bg-primary/10 text-primary'
      : 'bg-muted text-muted-foreground';

  return (
    <div className={`border rounded-lg p-3 ${statusColor} transition-colors`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-sm leading-tight">{issue.title}</h3>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${statusBadgeColor}`}
        >
          {statusLabel}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{issue.description}</p>
      <div className="text-[10px] text-muted-foreground mt-1.5">{issue.person_in_charge}</div>
    </div>
  );
}
