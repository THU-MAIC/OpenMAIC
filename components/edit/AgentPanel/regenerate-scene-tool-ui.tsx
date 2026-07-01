'use client';

/**
 * Tool-call UI for `regenerate_scene` (whole-slide regeneration). Renders via the
 * shared `ToolCard` as a single non-expandable status row (status mark + tooltip
 * only — no inline detail body). The "还原到重生成前 / Restore previous" button
 * lives on the always-visible card row (ToolCard `barAction`): whole-slide
 * regeneration applies directly to the canvas, so revert is one tap.
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface RegenerateSceneResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; content?: { elements?: unknown[] } | null; actions?: unknown[] };
}

function RegenerateSceneCard({
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
    ? t('edit.regenScene.generating')
    : stopped
      ? t('edit.agent.stopped')
      : failed
        ? t('edit.regenScene.notGenerated')
        : t('edit.regenScene.updated');

  return (
    <ToolCard
      title={t('edit.regenScene.title')}
      icon={Wrench}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
      // No Restore for a stopped/failed run — nothing was applied to revert.
      barAction={!failed && !stopped ? <RestoreButton toolCallId={toolCallId} /> : undefined}
    />
  );
}

export const RegenerateSceneUI = makeAssistantToolUI<
  { sceneId?: string; instruction?: string },
  RegenerateSceneResult
>({
  toolName: 'regenerate_scene',
  render: ({ args, status, result, isError, toolCallId }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    // The user cancelled the turn before this tool finished → loud stopped state.
    const stopped = !running && isStoppedResult(result);
    // pi-agent-core 0.78.0 does NOT propagate a tool result's `isError` into
    // `tool_execution_end.isError`, so refusals / generation-failures (which
    // return `details.content === null`, i.e. nothing was applied) would render
    // as a green "Updated" badge. Derive failure from the result too: if the run
    // finished but produced no content, treat it as failed.
    const noContentApplied =
      !running && !stopped && result != null && result.details?.content == null;
    const failed =
      !running && !stopped && (isError || status.type === 'incomplete' || noContentApplied);
    return (
      <RegenerateSceneCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        toolCallId={toolCallId}
      />
    );
  },
});
