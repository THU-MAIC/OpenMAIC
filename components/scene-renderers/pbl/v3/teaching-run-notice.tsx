'use client';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';

/** Recovery stays explicit and uses the existing retry command. */
export function TeachingRunNotice({
  run,
  disabled,
  retrying = false,
  blockedReason,
  onRetry,
}: {
  run: LearningView['roleRun'];
  disabled: boolean;
  retrying?: boolean;
  blockedReason?: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (!run || !['failed', 'cancelled', 'missing'].includes(run.status)) return null;
  return (
    <aside role="alert" className="pbl-recovery-notice" aria-busy={retrying}>
      <span className="pbl-recovery-icon" aria-hidden="true">
        <CircleAlert size={19} />
      </span>
      <div className="pbl-recovery-copy">
        <h4>{t('pblV3.run.recoveryTitle')}</h4>
        <p>{t(`pblV3.run.${run.failure ?? run.status}`)}</p>
        {run.canRetry && <p className="pbl-recovery-hint">{t('pblV3.run.recoveryHint')}</p>}
      </div>
      {run.canRetry && (
        <button
          type="button"
          className="pbl-recovery-action"
          disabled={disabled || retrying}
          title={blockedReason ? t(`pblV3.inputBlocked.${blockedReason}`) : undefined}
          onClick={onRetry}
        >
          {retrying ? (
            <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw size={15} aria-hidden="true" />
          )}
          {t(retrying ? 'pblV3.run.retrying' : 'pblV3.retryResponse')}
        </button>
      )}
    </aside>
  );
}
