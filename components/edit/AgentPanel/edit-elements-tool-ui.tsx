'use client';

/**
 * Tool-call UI for `edit_elements` (natural-language per-element edits).
 * Minimal non-expandable ToolCard — title + @scene pill + localized status.
 */
import { Move } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { editElementsOutcome } from '@/lib/agent/client/edit-elements-result';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';

interface EditElementsResult {
  content?: { type: string; text?: string }[];
  details?: {
    sceneId?: string;
    intents?: unknown[] | null;
    updateCount?: number;
    refuseReason?: string;
  };
}

function deriveEditElementsFailed(args: {
  running: boolean;
  stopped: boolean;
  isError: boolean;
  result?: EditElementsResult | null;
}): boolean {
  const { running, stopped, isError, result } = args;
  if (running || stopped) return false;
  const outcome = editElementsOutcome(result?.details);
  if (outcome === 'applied') return false;
  return isError || outcome === 'refused';
}

export function EditElementsCard({
  running,
  stopped,
  failed,
  sceneId,
}: {
  running: boolean;
  stopped: boolean;
  failed: boolean;
  sceneId?: string;
}) {
  const { t } = useI18n();
  const toolStatus: ToolStatus = running
    ? 'running'
    : stopped
      ? 'stopped'
      : failed
        ? 'failed'
        : 'done';
  const baseLabel = running
    ? t('edit.editElements.editing')
    : stopped
      ? t('edit.agent.stopped')
      : failed
        ? t('edit.editElements.notApplied')
        : t('edit.editElements.applied');

  return (
    <ToolCard
      title={t('edit.editElements.title')}
      icon={Move}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={baseLabel}
    />
  );
}

export const EditElementsUI = makeAssistantToolUI<
  { sceneId?: string; instruction?: string },
  EditElementsResult
>({
  toolName: 'edit_elements',
  render: ({ args, status, result, isError }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    const stopped = !running && isStoppedResult(result);
    const failed = deriveEditElementsFailed({
      running,
      stopped,
      isError: !!isError,
      result,
    });
    return (
      <EditElementsCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
      />
    );
  },
});
