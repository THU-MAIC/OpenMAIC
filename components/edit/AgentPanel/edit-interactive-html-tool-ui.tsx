'use client';

/**
 * Tool-call UI for `edit_interactive_html` (interactive-scene str_replace edits).
 * A minimal, NON-expandable `ToolCard` — just the title + @scene pill + status
 * badge, plus the "还原 / Restore previous" button on the always-visible row.
 * (No expandable body: the edit count / error detail is intentionally omitted.)
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';
import { deriveEditFailed, type EditInteractiveHtmlResult } from './edit-tool-state';

function EditInteractiveHtmlCard({
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
    ? t('edit.fixHtml.fixing')
    : stopped
      ? t('edit.agent.stopped')
      : failed
        ? t('edit.fixHtml.notFixed')
        : t('edit.fixHtml.fixed');

  return (
    <ToolCard
      title={t('edit.fixHtml.title')}
      icon={Wrench}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
      // No Restore for a stopped/failed run — nothing was applied to revert.
      barAction={!failed && !stopped ? <RestoreButton toolCallId={toolCallId} /> : undefined}
    />
  );
}

export const EditInteractiveHtmlUI = makeAssistantToolUI<
  { sceneId?: string; edits?: { oldText: string; newText: string }[] },
  EditInteractiveHtmlResult
>({
  toolName: 'edit_interactive_html',
  render: ({ args, status, result, isError, toolCallId }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    // The user cancelled the turn before this tool finished → loud stopped state.
    const stopped = !running && isStoppedResult(result);
    // Bias-to-success failure derivation (see edit-tool-state): only an explicit
    // error or a null-html refusal is a failure — a successful apply, or a
    // missing/slimmed result, is never "failed".
    const failed = deriveEditFailed({ running, stopped, isError: !!isError, result });
    return (
      <EditInteractiveHtmlCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        toolCallId={toolCallId}
      />
    );
  },
});
