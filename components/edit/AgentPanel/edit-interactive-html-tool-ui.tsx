'use client';

/**
 * Tool-call UI for `edit_interactive_html` (interactive-scene str_replace edits).
 * Renders via the shared `ToolCard`; the body reports how many edits applied, or
 * the actionable error when an edit could not be anchored. The "还原 / Restore
 * previous" button lives on the always-visible card row.
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface EditInteractiveHtmlResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; html?: string | null; editCount?: number };
}

function EditInteractiveHtmlCard({
  running,
  stopped,
  failed,
  sceneId,
  editCount,
  failText,
  toolCallId,
}: {
  running: boolean;
  stopped: boolean;
  failed: boolean;
  sceneId?: string;
  editCount: number;
  failText?: string;
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

  const hasBody = (!failed && !stopped && editCount > 0) || (failed && !!failText);

  return (
    <ToolCard
      title={t('edit.fixHtml.title')}
      icon={Wrench}
      sceneId={sceneId}
      status={toolStatus}
      statusLabel={statusLabel}
      // No Restore for a stopped/failed run — nothing was applied to revert.
      barAction={!failed && !stopped ? <RestoreButton toolCallId={toolCallId} /> : undefined}
    >
      {hasBody ? (
        <>
          {failed && failText ? (
            <p className="text-amber-600 dark:text-amber-500">{failText}</p>
          ) : null}
          {!failed && !stopped && editCount > 0 ? (
            <p className="font-mono">{t('edit.fixHtml.editsCount', { count: editCount })}</p>
          ) : null}
        </>
      ) : null}
    </ToolCard>
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
    // pi-agent-core does not propagate a result's `isError` into the event, so a
    // refusal / unappliable-edit (which returns `details.html === null`, i.e.
    // nothing applied) would render as a green "Fixed" badge. Derive failure too.
    const noHtmlApplied = !running && !stopped && result != null && result.details?.html == null;
    const failed = !running && !stopped && (isError || status.type === 'incomplete' || noHtmlApplied);
    return (
      <EditInteractiveHtmlCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        editCount={result?.details?.editCount ?? args?.edits?.length ?? 0}
        failText={result?.content?.[0]?.text}
        toolCallId={toolCallId}
      />
    );
  },
});
