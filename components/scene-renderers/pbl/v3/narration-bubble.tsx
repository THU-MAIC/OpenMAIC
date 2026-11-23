'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
import { PresentationBubbleCard } from '@/components/roundtable/presentation-speech-overlay';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import type { ToolPart } from '@/lib/pbl/v3/narration';
import { ROLE_PERSONAS } from '@/lib/pbl/v3/personas';
import { BubbleTools } from './tool-activity';

/** One piece of what is said: a step of the reply being told, or a line of the role's own. */
type Speech = { id: string; text: string };

/**
 * True for a moment after `value` appears. What the learner sent stays just long enough to be
 * seen to land; after that the bubble is the role's again, waiting, until it speaks.
 */
function useHeld(value: string | undefined, ms: number) {
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => setReleased(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return !!value && released !== value;
}

function Segment({
  role,
  speech,
  readingOpening,
  tools,
  working,
  paused,
  audio,
  onPause,
  onOpen,
  onCollapse,
}: {
  role: AgentRole;
  speech?: Speech;
  readingOpening?: boolean;
  tools: readonly ToolPart[];
  /** The reply is still being produced or told. */
  working: boolean;
  paused: boolean;
  audio: AudioIndicatorState;
  onPause?: () => void;
  onOpen: () => void;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const calls = tools.filter((tool) => !tool.recovered);
  return (
    <PresentationBubbleCard
      bubble={{
        key: speech?.id ?? 'pending',
        role: 'teacher',
        side: 'right',
        name: t(`pblV3.personas.${role}`),
        roleLabel: t(`pblV3.roles.${role}`),
        avatar: ROLE_PERSONAS[role].avatar,
        // The buffer reveals the text; the bubble shows what it is given.
        text: speech?.text ?? '',
        // No words yet while the role is at work: the bubble says so instead of standing
        // empty. A reply that is over is never shown as waiting.
        isLoading: !speech && working,
        isTopicPending: false,
        follow: readingOpening ? 'manual' : true,
      }}
      audioIndicatorState={audio}
      isPaused={paused}
      buttonState={onPause ? (paused ? 'play' : 'none') : 'none'}
      onClick={onPause}
      onExpand={onOpen}
      onCollapse={onCollapse}
      footer={
        calls.length > 0 ? (
          // The tool calls that follow these words, in the bubble's own hand.
          <div
            // The resume button sits in the card's bottom corner; the tool line stops short of it.
            className={`flex flex-col gap-1.5 border-t border-gray-200/70 pt-2.5 dark:border-gray-700/60 ${paused ? 'me-8' : ''}`}
            data-testid="pbl-companion-tools"
            onClick={(event) => event.stopPropagation()}
          >
            <BubbleTools tools={calls} t={t} />
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * The conversation as a speech bubble: the classroom's own bubble card holding one piece of
 * the role's text and, under it, the tool calls that follow that text in the stream. The next
 * piece of text is the next bubble. A click pauses the telling; the corner opens the whole
 * conversation or puts the bubble away.
 */
export function NarrationBubble({
  role,
  speech,
  readingOpening,
  learner,
  tools,
  playing,
  paused = false,
  waiting,
  audio,
  onPause,
  onOpen,
  onCollapse,
}: {
  role: AgentRole;
  speech?: Speech;
  readingOpening?: boolean;
  /** What the learner just sent, held until the role's reply has its first words. */
  learner?: string;
  tools: readonly ToolPart[];
  playing: boolean;
  paused?: boolean;
  /** The reply is still being produced and there is nothing newer to show. */
  waiting: boolean;
  audio: AudioIndicatorState;
  onPause?: () => void;
  /** Open the whole conversation. */
  onOpen: () => void;
  /** Put the bubble away. */
  onCollapse: () => void;
}) {
  const holding = useHeld(learner, 1600);
  const mine = !!learner && holding;
  // The classroom's own bubble transition: one leaves, then the next comes in from the side
  // it speaks from. The role's bubble stays put from one piece of text to the next, so within
  // a reply only its words change.
  const swap = {
    initial: { opacity: 0, x: 20, y: 12 },
    animate: { opacity: 1, x: 0, y: 0 },
    exit: { opacity: 0, y: 8 },
    transition: { duration: 0.22, ease: [0.21, 1, 0.36, 1] as const },
  };
  return (
    <div
      className="relative flex flex-col items-end gap-1.5"
      data-playing={playing || undefined}
      data-paused={paused || undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        {mine ? (
          <motion.div
            key="learner"
            {...swap}
            className="w-full"
            data-testid="pbl-companion-learner"
          >
            <PresentationBubbleCard
              bubble={{
                key: 'learner',
                role: 'user',
                side: 'right',
                name: '',
                avatar: DEFAULT_USER_AVATAR,
                text: learner,
                isLoading: false,
                isTopicPending: false,
                follow: true,
              }}
              onExpand={onOpen}
              onCollapse={onCollapse}
            />
          </motion.div>
        ) : (
          <motion.div
            key="role"
            {...swap}
            // What the learner sends takes its place at once: nothing already on screen moves
            // or lingers at the moment of sending.
            exit={{ opacity: 0, transition: { duration: 0 } }}
            className="relative w-full"
          >
            <Segment
              role={role}
              // Until the reply to what was just sent has words, the role is at work: its tool
              // calls show as they are made.
              speech={learner ? undefined : speech}
              readingOpening={readingOpening}
              tools={tools}
              working={playing || waiting || !!learner}
              paused={paused}
              audio={playing ? (waiting && audio === 'idle' ? 'generating' : audio) : 'idle'}
              onPause={playing ? onPause : undefined}
              onOpen={onOpen}
              onCollapse={onCollapse}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
