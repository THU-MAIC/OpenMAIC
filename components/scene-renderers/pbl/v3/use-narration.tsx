'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import {
  boardAt,
  boardWrites,
  narrationSegments,
  narrationSteps,
  pointerAt,
  recoveredReviewSpeech,
  spokenText,
  type NarrationProgress,
  type NarrationTarget,
} from '@/lib/pbl/v3/narration';
import { PBL_NARRATORS } from '@/lib/pbl/v3/personas';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import { WB_DRAW_MS } from '@/lib/choreography/timing';
import { useSettingsStore } from '@/lib/store/settings';

/** Silent reading time for one piece of speech when no voice is available. */
const readingTime = (text: string) => Math.max(1500, Array.from(text).length * 220);
/** A wiped board takes this long to sweep away before anything new is written on it. */
const SWEEP = 1000;
/** The classroom's own pacing for a live turn: a breath after speech, a beat after each action. */
const PACING = { postTextDelayMs: 1200, actionDelayMs: WB_DRAW_MS };
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Tells the role's reply through the classroom's own pacing layer. The stream fills a
 * StreamBuffer as fast as it comes; the buffer's one playhead walks it as the classroom
 * does: text is revealed character by character and read aloud, the playhead holds until
 * the voice has finished it, and only then are the calls that follow made, one at a time.
 * The bubble, the tool line under it, the whiteboard and the pointer all follow that one
 * playhead. Only a reply seen while it was being produced is told; history rests on its
 * last word.
 */
export function useNarration(
  conversation: LearningConversationEntry[],
  stageKey: string,
  {
    onPoint,
    onBoard,
    onTold,
    nextInstruction,
  }: {
    nextInstruction?: string;
    /** The role points at code or at the running application, or stops pointing. */
    onPoint?: (point: NarrationTarget | null) => void;
    /** The role brings the whiteboard into view, or puts it away. */
    onBoard?: (show: boolean) => void;
    /** How far the telling has got, for whatever else shows the same conversation. */
    onTold?: (told: NarrationProgress | null) => void;
  },
) {
  const entry = conversation.findLast((item) => !item.boundary && item.speaker !== 'user');
  const steps = useMemo(
    () => (entry ? narrationSteps(entry, nextInstruction) : []),
    [entry, nextInstruction],
  );
  const segments = useMemo(() => narrationSegments(steps), [steps]);
  const writes = useMemo(() => boardWrites(steps), [steps]);
  const complete = !!entry && entry.status !== 'running';
  const ttsMuted = useSettingsStore((state) => state.ttsMuted);
  const [audio, setAudio] = useState<AudioIndicatorState>('idle');
  const tts = useDiscussionTTS({
    enabled: !ttsMuted,
    agents: PBL_NARRATORS,
    onAudioStateChange: (_agent, state) => setAudio(state),
  });
  const ttsRef = useRef(tts);
  const latest = useRef({ steps, complete });
  useEffect(() => {
    ttsRef.current = tts;
    latest.current = { steps, complete };
  });

  // Where the buffer's playhead is: the step being told, how much of its text is out, and
  // whether the learner has paused the telling.
  const [stage, setStage] = useState<{
    id: string;
    head: number;
    text: string;
    paused: boolean;
  } | null>(null);
  const run = useRef<{
    id: string;
    buffer: StreamBuffer;
    /** Steps handed to the buffer so far, and how much of the last piece of text. */
    fed: number;
    fedText: number;
    sealed: boolean;
    done: boolean;
    /**
     * Where in the reply each text part given to the buffer is, in the order given: the
     * buffer's part ids count them. A place, not an id: a part's id changes when the stream
     * finishes it.
     */
    says: number[];
    /** Speech given to the voice, and when its silent reading began if there is no voice. */
    voiced: Set<number>;
    reading: { id: string; since: number; ms: number } | null;
  } | null>(null);
  // A reply the learner stopped is not taken up again while it is still being produced.
  const [stopped, setStopped] = useState<string | null>(null);
  const running = entry?.status === 'running' ? entry.id : null;
  const live = running !== stopped ? running : null;
  const speaker = entry?.speaker;

  const stop = () => {
    run.current?.buffer.shutdown();
    ttsRef.current.cleanup();
    setStage(null);
  };
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });

  useEffect(() => {
    if (!live || run.current?.id === live) return;
    run.current?.buffer.shutdown();
    ttsRef.current.cleanup();
    const id = live;
    const mine = () => (run.current?.id === id ? run.current : null);
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal(_message, partId, revealed) {
          const state = mine();
          const head = state?.says[Number(partId.slice(1))] ?? -1;
          const step = latest.current.steps[head];
          if (!state || !step || step.kind !== 'say') return;
          // The voice gets a piece of text when the playhead is on it and it is whole.
          if (!step.streaming && !state.voiced.has(head)) {
            state.voiced.add(head);
            ttsRef.current.handleSegmentSealed(id, step.id, step.text, speaker ?? null);
            // Muted, or no voice for this role: the playhead holds for reading time instead.
            state.reading = ttsRef.current.shouldHold().holding
              ? null
              : { id: step.id, since: Date.now(), ms: readingTime(step.text) };
          }
          setStage((now) =>
            now?.id === id && now.head === head && now.text === revealed
              ? now
              : { id, head, text: revealed, paused: now?.paused ?? false },
          );
        },
        async onActionReady(_message, action, signal) {
          // The call is shown being made, and the playhead stays on it until it is done:
          // only then is what it drew on the board, and it is given its beat to be seen.
          const head = Number(action.actionId);
          setStage((now) => ({ id, head, text: '', paused: now?.paused ?? false }));
          for (;;) {
            const step = latest.current.steps[head];
            if (signal.aborted || !step || step.kind === 'say') return;
            if (step.tool.status !== 'running') {
              if (step.kind === 'board' && step.clear) await wait(SWEEP, signal);
              return;
            }
            await wait(100, signal);
          }
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          if (mine()) setStage(null);
        },
        onError() {},
        shouldHoldAfterReveal() {
          const state = mine();
          const hold = ttsRef.current.shouldHold();
          if (hold.holding || !state?.reading) return hold;
          // No voice: hold for as long as the text takes to read.
          return Date.now() - state.reading.since < state.reading.ms
            ? { holding: true, segmentDone: hold.segmentDone }
            : hold;
        },
      },
      PACING,
    );
    run.current = {
      id,
      buffer,
      fed: 0,
      fedText: 0,
      sealed: true,
      done: false,
      says: [],
      voiced: new Set(),
      reading: null,
    };
    buffer.start();
    setStage({ id, head: 0, text: '', paused: false });
  }, [live, speaker]);

  // The stream fills the buffer: new steps are queued, growing text is appended in place.
  useEffect(() => {
    const state = run.current;
    if (!state || state.id !== entry?.id || state.done) return;
    const { buffer } = state;
    const last = steps[state.fed - 1];
    if (last?.kind === 'say' && !state.sealed) {
      if (last.text.length > state.fedText) {
        buffer.pushText(state.id, last.text.slice(state.fedText), speaker);
        state.fedText = last.text.length;
      }
      if (!last.streaming) {
        buffer.sealText(state.id);
        state.sealed = true;
      }
    }
    for (; state.fed < steps.length; state.fed++) {
      const step = steps[state.fed];
      if (step.kind === 'say') {
        // One text part per piece of speech: the part before it is closed first.
        buffer.sealText(state.id);
        state.says.push(state.fed);
        buffer.pushText(state.id, step.text, speaker);
        state.fedText = step.text.length;
        state.sealed = !step.streaming;
        if (state.sealed) buffer.sealText(state.id);
      } else {
        buffer.pushAction({
          messageId: state.id,
          actionId: String(state.fed),
          actionName: step.tool.name ?? step.tool.action,
          params: {},
          agentId: speaker ?? '',
        });
        state.sealed = true;
      }
    }
    if (complete) {
      buffer.pushDone({ totalActions: 0, totalAgents: 1 });
      state.done = true;
    }
  }, [steps, complete, entry?.id, speaker, live]);

  const active = stage && entry?.id === stage.id ? stage : null;
  // A reply that failed or was replaced ends its telling with it.
  const failed = !!entry && ['failed', 'cancelled', 'interrupted'].includes(entry.status ?? '');
  useEffect(() => {
    if (failed) stopRef.current();
  }, [failed]);
  useLayoutEffect(
    () => () => {
      const previous = run.current;
      run.current = null;
      previous?.buffer.shutdown();
      ttsRef.current.cleanup();
    },
    [stageKey],
  );

  const playing = !!active && !failed;
  const head = playing ? Math.min(active.head, steps.length - 1) : -1;
  // At rest the bubble holds the last thing the role said, not the tool calls that closed
  // the reply after it: those have no words, and a bubble without words reads as waiting.
  const at = playing
    ? segments.findIndex((item) => item.from <= head && head <= item.to)
    : Math.max(
        segments.findLastIndex((item) => !!item.say),
        segments.length ? 0 : -1,
      );
  const segment = segments[at];
  const reach = playing ? head : (segment?.to ?? -1);

  const pointed = playing ? pointerAt(steps, reach) : undefined;
  const pointKey = pointed?.id ?? null;
  const point = useRef({ onPoint, target: pointed?.target });
  useEffect(() => {
    point.current = { onPoint, target: pointed?.target };
  });
  useEffect(() => {
    point.current.onPoint?.(pointKey ? (point.current.target ?? null) : null);
  }, [pointKey]);
  useEffect(() => () => point.current.onPoint?.(null), []);

  // The whiteboard follows the role's own calls: in view from a board call, away on wb_close.
  const boarded = playing ? boardAt(steps, reach) : undefined;
  const boardKey = boarded?.id ?? null;
  const board = useRef({ onBoard, show: boarded?.show });
  useEffect(() => {
    board.current = { onBoard, show: boarded?.show };
  });
  useEffect(() => {
    if (boardKey && board.current.show !== undefined) board.current.onBoard?.(board.current.show);
  }, [boardKey]);

  // A click pauses the telling where it is, voice, bubble and board together; the reply
  // keeps arriving into the buffer meanwhile. A second click goes on from the same place.
  const togglePause = () => {
    const state = run.current;
    if (!state || !active) return;
    const paused = !active.paused;
    if (paused) {
      state.buffer.pause();
      ttsRef.current.pause();
    } else {
      state.buffer.resume();
      ttsRef.current.resume();
    }
    setStage((now) => (now ? { ...now, paused } : now));
  };

  // Reported character by character: the pane shows exactly what the bubble does, so a
  // sentence never rests a few characters short while it is being read out.
  const step = steps[head];
  const toldPart = playing && step ? step.part : -1;
  const revealed =
    playing && step?.kind === 'say' && step.text ? active.text.length / step.text.length : 0;
  const passage = step?.kind === 'say' ? step.passage : undefined;
  const said = passage ? passage.from + revealed * (passage.to - passage.from) : revealed;
  const told = useRef({ onTold, id: entry?.id });
  useEffect(() => {
    told.current = { onTold, id: entry?.id };
  });
  useEffect(() => {
    const { onTold, id } = told.current;
    onTold?.(playing && id ? { id, part: toldPart, said } : null);
  }, [playing, toldPart, said]);
  useEffect(() => () => told.current.onTold?.(null), []);

  const say = segment?.say;
  const handoff = say && entry?.parts[say.part]?.kind === 'tool';
  const restingReview = playing || handoff ? undefined : recoveredReviewSpeech(entry);
  const restingPart = !playing && say?.passage ? entry?.parts[say.part] : undefined;
  let displayedSpeech =
    restingReview ??
    (say && playing && steps[head]?.id === say.id
      ? { ...say, text: active.text, streaming: true }
      : say && restingPart?.kind === 'text'
        ? { ...say, text: spokenText(restingPart.text) }
        : say);
  if (handoff && displayedSpeech) {
    // The host adds a spoken button hint to the tutor's closing words. Keep those
    // words readable while the hint is revealed, without queuing them for speech again.
    const previous = steps.findLast((step) => step.kind === 'say' && step.part < say.part);
    const closing = previous && entry.parts[previous.part];
    if (closing?.kind === 'text')
      displayedSpeech = {
        ...displayedSpeech,
        text: spokenText(closing.text) + '\n\n' + displayedSpeech.text,
      };
  }
  return {
    /** A live reply is being told; otherwise the bubble rests on the last thing said. */
    playing,
    paused: playing && active.paused,
    togglePause,
    /** Ends the telling of this reply where it is; what is left of it is not told later. */
    stop: () => {
      if (entry?.id) setStopped(entry.id);
      stop();
    },
    speaker,
    /**
     * The piece of text in the bubble, as far as the playhead has revealed it; none while the
     * reply has only called tools so far.
     */
    speech: displayedSpeech,
    /** The calls that follow that text which the telling has reached, in order. */
    tools: !segment
      ? []
      : playing
        ? steps
            .slice(segment.from, head + 1)
            .flatMap((step) => (step.kind === 'say' ? [] : [step.tool]))
        : segment.tools,
    /** Everything so far has been told and the reply is still being produced. */
    waiting: playing && !complete && head >= steps.length - 1,
    /** What the role has written that the telling has not reached: not on the board yet. */
    hidden: new Set(
      playing ? writes.flatMap((write) => (write.index > head ? write.ids : [])) : [],
    ),
    /** Wipes the role has made that the telling has not reached: the board is still as it was. */
    clears: playing ? writes.filter((write) => write.clear && write.index > head).length : 0,
    /** Elements the role has since taken off the board that the telling has not reached. */
    kept: new Set(
      playing
        ? steps.flatMap((step, index) =>
            step.kind === 'board' && index > head ? (step.removes ?? []) : [],
          )
        : [],
    ),
    audio,
  };
}

/**
 * The telling as a component, so the voice and the buffer are mounted only where the role is
 * a companion and never for a stage without one.
 */
export function Narrated({
  conversation,
  stageKey,
  children,
  ...handlers
}: Parameters<typeof useNarration>[2] & {
  conversation: LearningConversationEntry[];
  stageKey: string;
  children: (narration: ReturnType<typeof useNarration>) => ReactNode;
}) {
  return children(useNarration(conversation, stageKey, handlers));
}
