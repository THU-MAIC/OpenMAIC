'use client';

import { StepVisualizer } from '@/app/generation-preview/components/visualizers';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { ToolCard } from '../chat/tool-card';
import { ThinkingBlock } from '../chat/thinking-block';
import { WaitingBar } from '../chat/waiting-bar';
import { TextBlock } from '../chat/text-block';
import { QuestionCard } from '../chat/question-card';
import { useI18n } from '@/lib/hooks/use-i18n';
import { requestActivity } from '@/lib/workbench/request-activity';

/** A projection of the real conversation, never a synthetic plan or tool history. */
export function WorkspaceRequestActivity() {
  const chat = useWorkbenchStore((s) => s.chat);
  const status = useWorkbenchStore((s) => s.status);
  const replaying = useWorkbenchStore((s) => s.replaying);
  const { t } = useI18n();
  const activity = requestActivity(chat, status, replaying);
  if (!activity) return null;
  const { node, stepId } = activity;
  return (
    <section
      data-testid="workspace-request-activity"
      className="wbchat ws-pane flex min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-6"
    >
      {stepId ? <StepVisualizer stepId={stepId} /> : null}
      <div className="w-full max-w-lg">
        {node.kind === 'question' ? (
          // Read-only: the answer is given in the conversation's own form.
          <QuestionCard node={node} t={t} />
        ) : node.kind === 'tool' ? (
          <ToolCard node={node} t={t} />
        ) : node.kind === 'thinking' ? (
          <ThinkingBlock
            text={node.text}
            streaming={node.streaming}
            startedAt={node.startedAt}
            endedAt={node.endedAt}
            t={t}
          />
        ) : node.kind === 'waiting' ? (
          <WaitingBar t={t} />
        ) : (
          <TextBlock text={node.text} />
        )}
      </div>
    </section>
  );
}
