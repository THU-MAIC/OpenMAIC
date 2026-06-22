'use client';

/**
 * Tool-call UI for `fix_interactive_html` (interactive-scene bug fix). Renders via
 * the shared `ToolCard`; the body echoes the reported bug. The "还原到重生成前 /
 * Restore previous" button lives on the always-visible card row (ToolCard
 * `barAction`): the fix applies directly to the page, so revert is one tap.
 */
import { Wrench } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface FixInteractiveHtmlResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; html?: string | null };
}

function FixInteractiveHtmlCard({
  running,
  stopped,
  failed,
  sceneId,
  bugDescription,
  failText,
  toolCallId,
}: {
  running: boolean;
  stopped: boolean;
  failed: boolean;
  sceneId?: string;
  bugDescription?: string;
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

  const hasBody = !!bugDescription || (failed && !!failText);

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
          {bugDescription ? <p className="italic">“{bugDescription}”</p> : null}
        </>
      ) : null}
    </ToolCard>
  );
}

export const FixInteractiveHtmlUI = makeAssistantToolUI<
  { sceneId?: string; bugDescription?: string },
  FixInteractiveHtmlResult
>({
  toolName: 'fix_interactive_html',
  render: ({ args, status, result, isError, toolCallId }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    // The user cancelled the turn before this tool finished → loud stopped state.
    const stopped = !running && isStoppedResult(result);
    // Mirror regenerate_scene: pi-agent-core does not propagate a result's
    // `isError` into `tool_execution_end.isError`, so refusals / fix failures
    // (which return `details.html === null`, i.e. nothing was applied) would
    // render as a green "Fixed" badge. Derive failure from the result too.
    const noHtmlApplied = !running && !stopped && result != null && result.details?.html == null;
    const failed = !running && !stopped && (isError || status.type === 'incomplete' || noHtmlApplied);
    return (
      <FixInteractiveHtmlCard
        running={running}
        stopped={stopped}
        failed={failed}
        sceneId={args?.sceneId ?? result?.details?.sceneId}
        bugDescription={args?.bugDescription}
        failText={result?.content?.[0]?.text}
        toolCallId={toolCallId}
      />
    );
  },
});
