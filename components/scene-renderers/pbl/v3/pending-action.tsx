'use client';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
const actions = new Set([
  'open',
  'prepare',
  'begin',
  'chat',
  'next',
  'decide',
  'quiz',
  'evaluate',
  'collect',
  'compile',
  'retry',
  'cancel',
  'refresh',
  'read',
  'create',
  'rename',
  'delete',
  'run',
  'terminal',
  'stop',
]);
/** Acknowledge the click immediately; only server receipts change learning progress. */
export function PendingAction({ action }: { action: string | null }) {
  const { t } = useI18n();
  if (!action) return null;
  const label = t(`pblV3.pendingActions.${actions.has(action) ? action : 'working'}`);
  return (
    <span
      role="status"
      data-testid="pbl-pending-action"
      data-action={action}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={label}
    >
      <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
