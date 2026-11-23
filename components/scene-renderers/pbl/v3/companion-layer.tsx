'use client';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import {
  learnerTurn,
  suggestedReplies,
  type NarrationProgress,
  type NarrationTarget,
} from '@/lib/pbl/v3/narration';
import { continueActionLabel } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';
import { Companion } from './companion';
import { ExplainBoard } from './explain-board';
import { NarrationBubble } from './narration-bubble';
import { TeachingRunNotice } from './teaching-run-notice';
import { Narrated } from './use-narration';

/** How the whole conversation is shown: put away, as a window, or docked beside the work. */
export type AssistantMode = 'closed' | 'window' | 'docked';

/**
 * The conversation as the role tells it, over the work area: the whiteboard window, and the
 * role as a companion at the corner with what it is saying, what the stage asks of the learner,
 * and the learner's way to answer. It is the same conversation stream the docked pane lists,
 * told through one playhead; `onTold` reports how far that has got, so the pane shows the same.
 */
export function CompanionLayer({
  view,
  board,
  boardOpen,
  onBoard,
  onPoint,
  onTold,
  waitingToStart,
  startAction,
  task,
  onOpenTask,
  assistantMode,
  onAssistantMode,
  introducing,
  pendingAction,
  pendingMessage,
  pending,
  disabled,
  blockedReason,
  inputId,
  text,
  onTextChange,
  command,
}: {
  view: LearningView;
  board: NonNullable<LearningView['explainBoard']>;
  /** The whiteboard window is in view. */
  boardOpen: boolean;
  /** The role, or the learner, brings the whiteboard into view or puts it away. */
  onBoard: (show: boolean) => void;
  onPoint: (point: NarrationTarget | null) => void;
  onTold: (told: NarrationProgress | null) => void;
  /** Nothing has started yet: the role greets the learner and offers the way to begin. */
  waitingToStart: boolean;
  startAction: ReactNode;
  /** What the stage asks of the learner here: a decision, the quiz, the tests and their result. */
  task: ReactNode;
  onOpenTask: () => void;
  assistantMode: AssistantMode;
  onAssistantMode: (mode: AssistantMode) => void;
  /** The controls around the avatar are being introduced and stay out. */
  introducing: boolean;
  pendingAction: string | null;
  pendingMessage: LearningConversationEntry | null;
  /** A request is on its way. */
  pending: boolean;
  disabled: boolean;
  blockedReason: string | null;
  inputId: string;
  text: string;
  onTextChange: (text: string) => void;
  command: (type: string, payload?: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useI18n();
  // The bubble can be put away to see the work under it; the next reply brings it back.
  const [bubbleAway, setBubbleAway] = useState<string | null>(null);
  const bubbleKey = `${view.id}:${view.conversation?.at(-1)?.id ?? ''}:${pendingMessage?.id ?? ''}`;
  const requesting = ['chat', 'begin', 'retry'].includes(pendingAction ?? '');
  const testStage = view.stage.kind === 'check' && view.stage.checker === 'tests';
  const role = view.role ?? 'mentor';
  return (
    <Narrated view={view} onBoard={onBoard} onPoint={onPoint} onTold={onTold}>
      {(narration) => (
        <>
          {boardOpen && !waitingToStart && (
            <ExplainBoard
              board={board}
              hidden={narration.hidden}
              clears={narration.clears}
              kept={narration.kept}
              onClose={() => onBoard(false)}
            />
          )}
          {assistantMode !== 'docked' && (
            <Companion
              view={view}
              bubbleAway={!waitingToStart && bubbleAway === bubbleKey}
              onShowBubble={() => setBubbleAway(null)}
              speech={
                waitingToStart ? (
                  // Nothing starts until the learner says so: one line of greeting and the way
                  // to begin. The project's overview is in the conversation for whoever wants
                  // to read it first.
                  <div className="flex flex-col items-end gap-2" data-testid="pbl-project-start">
                    <NarrationBubble
                      role={role}
                      speech={{
                        id: 'greeting',
                        text: t('pblV3.tour.greeting', { name: t(`pblV3.personas.${role}`) }),
                      }}
                      tools={[]}
                      playing={false}
                      waiting={false}
                      audio="idle"
                      onOpen={() => onAssistantMode('window')}
                      onCollapse={() => {}}
                    />
                    <div className="pbl-start-bar w-full">{startAction}</div>
                  </div>
                ) : (
                  <NarrationBubble
                    role={
                      narration.speaker && narration.speaker !== 'user' ? narration.speaker : role
                    }
                    speech={narration.speech}
                    learner={learnerTurn(view.conversation ?? [], pendingMessage)}
                    tools={narration.tools}
                    playing={narration.playing}
                    paused={narration.paused}
                    onPause={narration.togglePause}
                    waiting={narration.waiting || (!narration.playing && (view.busy || requesting))}
                    audio={narration.audio}
                    onOpen={() => onAssistantMode('window')}
                    onCollapse={() => setBubbleAway(bubbleKey)}
                  />
                )
              }
              historyOpen={assistantMode !== 'closed'}
              notice={
                // A reply the learner stopped needs no notice here: the input is already back.
                // Retrying it stays in the conversation.
                view.roleRun && ['failed', 'missing'].includes(view.roleRun.status) ? (
                  <TeachingRunNotice
                    run={view.roleRun}
                    disabled={disabled}
                    retrying={pendingAction === 'retry'}
                    blockedReason={blockedReason}
                    onRetry={() => void command('retry')}
                  />
                ) : undefined
              }
              onToggleHistory={() =>
                onAssistantMode(assistantMode === 'closed' ? 'window' : 'closed')
              }
              onOpenTask={onOpenTask}
              // The stage's one primary action sits by the avatar: move on, or run the tests.
              continueLabel={
                view.actions.includes('next')
                  ? continueActionLabel(view, t)
                  : testStage && view.actions.includes('evaluate') && !view.evaluation
                    ? t('pblV3.runTests')
                    : undefined
              }
              onContinue={() => void command(view.actions.includes('next') ? 'next' : 'evaluate')}
              continuing={pendingAction === 'next' || pendingAction === 'evaluate'}
              disabled={disabled}
              canChat={view.actions.includes('chat')}
              active={narration.playing || view.busy || requesting}
              onStop={() => {
                // Cut in: the telling ends here, and so does the run behind it.
                narration.stop();
                if (view.busy) void command('cancel');
              }}
              inputId={inputId}
              text={text}
              onTextChange={onTextChange}
              onSend={(message) => void command('chat', { text: message })}
              sending={pendingAction === 'chat'}
              showControls={introducing}
              // What the stage asks of the learner comes once the role has said so.
              task={narration.playing || view.busy ? undefined : task}
              suggestions={
                // What is on offer answers the last reply; once something is sent it is gone
                // at once, not when the server says so.
                narration.playing || view.busy || pending || pendingMessage
                  ? []
                  : suggestedReplies(view.conversation ?? [])
              }
            />
          )}
        </>
      )}
    </Narrated>
  );
}
