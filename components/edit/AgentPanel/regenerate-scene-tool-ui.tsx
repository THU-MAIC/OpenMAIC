'use client';

/**
 * Tool-call UI for `regenerate_scene` (whole-slide regeneration). Renders via the
 * shared `ToolCard`; the expandable body reports the regenerated slide (element
 * count) + the instruction. The "还原到重生成前 / Restore previous" button lives
 * on the always-visible card row (ToolCard `barAction`): whole-slide regeneration
 * applies directly to the canvas, so revert is one tap — no Ctrl+Z, no expanding.
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface RegenerateSceneResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; content?: { elements?: unknown[] } | null; actions?: unknown[] };
}

function RegenerateSceneCard({
  running,
  failed,
  sceneId,
  instruction,
  elementCount,
  failText,
  toolCallId,
}: {
  running: boolean;
  failed: boolean;
  sceneId?: string;
  instruction?: string;
  elementCount: number;
  failText?: string;
  toolCallId: string;
}) {
  const { t } = useI18n();
  const toolStatus: ToolStatus = running ? 'running' : failed ? 'failed' : 'done';
  const statusLabel = running
    ? t('edit.regenScene.generating')
    : failed
      ? t('edit.regenScene.notGenerated')
      : t('edit.regenScene.updated');

  const hasBody = !!instruction || elementCount > 0 || (failed && !!failText);

  return (
    <ToolCard
      title={t('edit.regenScene.title')}
      icon={Wrench}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
      barAction={!failed ? <RestoreButton toolCallId={toolCallId} /> : undefined}
    >
      {hasBody ? (
        <>
          {failed && failText ? (
            <p className="text-amber-600 dark:text-amber-500">{failText}</p>
          ) : null}
          {instruction ? <p className="italic">“{instruction}”</p> : null}
          {elementCount > 0 ? (
            <p className="font-mono">
              {t('edit.regenScene.elementsCount', { count: elementCount })}
            </p>
          ) : null}
        </>
      ) : null}
    </ToolCard>
  );
}

export const RegenerateSceneUI = makeAssistantToolUI<
  { sceneId?: string; instruction?: string },
  RegenerateSceneResult
>({
  toolName: 'regenerate_scene',
  render: ({ args, status, result, isError, toolCallId }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    // pi-agent-core 0.78.0 does NOT propagate a tool result's `isError` into
    // `tool_execution_end.isError`, so refusals / generation-failures (which
    // return `details.content === null`, i.e. nothing was applied) would render
    // as a green "Updated" badge. Derive failure from the result too: if the run
    // finished but produced no content, treat it as failed.
    const noContentApplied = !running && result != null && result.details?.content == null;
    const failed = !running && (isError || status.type === 'incomplete' || noContentApplied);
    return (
      <RegenerateSceneCard
        running={running}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        instruction={args?.instruction}
        elementCount={result?.details?.content?.elements?.length ?? 0}
        failText={result?.content?.[0]?.text}
        toolCallId={toolCallId}
      />
    );
  },
});
