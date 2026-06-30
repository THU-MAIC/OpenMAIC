'use client';

/**
 * Tool-call UI for `regenerate_scene_actions`. Renders via the shared `ToolCard`
 * as a single non-expandable status row (status mark + tooltip only — no inline
 * detail body). The "还原 / Restore previous" button lives on the card row.
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

function RegenerateActionsCard({
  running,
  stopped,
  failed,
  sceneId,
  toolCallId,
}: {
  running: boolean;
  stopped: boolean;
  failed: boolean;
  sceneId?: string;
  toolCallId: string;
}) {
  const { t } = useI18n();
  const toolStatus: ToolStatus = running
    ? 'running'
    : stopped
      ? 'stopped'
      : failed
        ? 'failed'
        : 'done';
  const statusLabel = running
    ? t('edit.regen.generating')
    : stopped
      ? t('edit.agent.stopped')
      : failed
        ? t('edit.regen.notGenerated')
        : t('edit.regen.updated');

  return (
    <ToolCard
      title={t('edit.regen.title')}
      icon={Wrench}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
      // No Restore for a stopped/failed run — nothing was applied to revert.
      barAction={!failed && !stopped ? <RestoreButton toolCallId={toolCallId} /> : undefined}
    />
  );
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>(
  {
    toolName: 'regenerate_scene_actions',
    render: ({ args, status, result, isError, toolCallId }) => {
      const running = status.type === 'running' || status.type === 'requires-action';
      // The user cancelled the turn before this tool finished → loud stopped state.
      const stopped = !running && isStoppedResult(result);
      // pi-agent-core 0.78.0 doesn't propagate a result's isError into the event,
      // so derive failure from the result too: a finished call that produced no
      // actions changed nothing — show "not generated", not a green "Updated".
      const noActions =
        !running && !stopped && result != null && (result.details?.actions?.length ?? 0) === 0;
      const failed = !running && !stopped && (isError || status.type === 'incomplete' || noActions);
      return (
        <RegenerateActionsCard
          running={running}
          stopped={stopped}
          failed={failed}
          sceneId={args?.sceneId ?? result?.details?.sceneId}
          toolCallId={toolCallId}
        />
      );
    },
  },
);
