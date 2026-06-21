'use client';

/**
 * Tool-call UI for `regenerate_scene_actions`. Renders via the shared `ToolCard`;
 * the body shows the resulting action breakdown (the board's red/green line diff
 * isn't rendered — this tool regenerates a scene's actions wholesale rather than
 * producing a text diff).
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cueLabel } from '@/components/edit/ActionsBar/cue-meta';
import { ToolCard, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

type TFn = (key: string, options?: Record<string, unknown>) => string;

interface RegenerateResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; actions?: { type?: string }[] };
}

function summarize(actions: { type?: string }[], t: TFn): string {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const type = a?.type ?? 'action';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, n]) => `${n} ${cueLabel(type, t)}`).join(' · ');
}

function RegenerateActionsCard({
  running,
  failed,
  sceneId,
  actions,
  failText,
  toolCallId,
}: {
  running: boolean;
  failed: boolean;
  sceneId?: string;
  actions: { type?: string }[];
  failText?: string;
  toolCallId: string;
}) {
  const { t } = useI18n();
  const toolStatus: ToolStatus = running ? 'running' : failed ? 'failed' : 'done';
  const statusLabel = running
    ? t('edit.regen.generating')
    : failed
      ? t('edit.regen.notGenerated')
      : t('edit.regen.updated');

  const hasBody = actions.length > 0 || (failed && !!failText);

  return (
    <ToolCard
      title={t('edit.regen.title')}
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
          {actions.length > 0 ? <p className="font-mono">{summarize(actions, t)}</p> : null}
        </>
      ) : null}
    </ToolCard>
  );
}

export const RegenerateSceneActionsUI = makeAssistantToolUI<{ sceneId?: string }, RegenerateResult>(
  {
    toolName: 'regenerate_scene_actions',
    render: ({ args, status, result, isError, toolCallId }) => {
      const running = status.type === 'running' || status.type === 'requires-action';
      // pi-agent-core 0.78.0 doesn't propagate a result's isError into the event,
      // so derive failure from the result too: a finished call that produced no
      // actions changed nothing — show "not generated", not a green "Updated".
      const noActions = !running && result != null && (result.details?.actions?.length ?? 0) === 0;
      const failed = !running && (isError || status.type === 'incomplete' || noActions);
      return (
        <RegenerateActionsCard
          running={running}
          failed={failed}
          sceneId={args?.sceneId ?? result?.details?.sceneId}
          actions={result?.details?.actions ?? []}
          failText={result?.content?.[0]?.text}
          toolCallId={toolCallId}
        />
      );
    },
  },
);
