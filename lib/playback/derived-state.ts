/**
 * Derived Playback State - Pure function that computes a high-level PlaybackView
 * from the ~15 raw state variables scattered across Stage.
 *
 * This centralises all "what is happening now?" derivation logic so that
 * both Stage and Roundtable can consume a single, consistent view object
 * instead of re-deriving the same conditions inline.
 */

import type { EngineMode, TriggerEvent } from './types';

// ---------------------------------------------------------------------------
// Input: raw state collected from Stage's useState variables
// ---------------------------------------------------------------------------

export interface PlaybackRawState {
  engineMode: EngineMode;
  lectureSpeech: string | null;
  liveSpeech: string | null;
  speakingAgentId: string | null;
  thinkingState: { stage: string; agentId?: string } | null;
  isCueUser: boolean;
  isTopicPending: boolean;
  chatIsStreaming: boolean;
  discussionTrigger: TriggerEvent | null;
  playbackCompleted: boolean;
  idleText: string | null;
  /** Whether the speaking agent is a student (not teacher). Provided by caller. */
  speakingStudent: boolean;
  /** Active session type — stays set between agent-loop turns (cleared only by doSessionCleanup). */
  sessionType: string | null;
}

// ---------------------------------------------------------------------------
// Output: a single derived view consumed by Roundtable (and Stage for gating)
// ---------------------------------------------------------------------------

export type PlaybackPhase =
  | 'idle'
  | 'lecturePlaying'
  | 'lecturePaused'
  | 'waitingProactive'
  | 'discussionActive'
  | 'discussionPaused'
  | 'cueUser'
  | 'completed';

export type BubbleButtonState = 'bars' | 'play' | 'restart' | 'none';

export interface PlaybackView {
  /** High-level phase — "what is happening right now?" */
  phase: PlaybackPhase;

  /** Text to display in the speech bubble (without userMessage overlay) */
  sourceText: string;

  /** Who owns the speech bubble */
  bubbleRole: 'teacher' | 'agent' | 'user' | null;

  /** Who is actively speaking (avatar highlight) */
  activeRole: 'teacher' | 'agent' | 'user' | null;

  /** Bubble button state */
  buttonState: BubbleButtonState;

  /** Whether we're in a live SSE flow (suppresses lecture text) */
  isInLiveFlow: boolean;

  /** Whether any topic-related activity blocks scene switching */
  isTopicActive: boolean;
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

export function computePlaybackView(raw: PlaybackRawState): PlaybackView {
  const {
    engineMode,
    lectureSpeech,
    liveSpeech,
    speakingAgentId,
    thinkingState,
    isCueUser,
    isTopicPending,
    chatIsStreaming,
    discussionTrigger,
    playbackCompleted,
    idleText,
    speakingStudent,
    sessionType,
  } = raw;

  // ---- isInLiveFlow ----
  // True when there's any live SSE activity (agent speaking, thinking, or streaming).
  // Includes chatIsStreaming to cover the entire QA session (gaps between
  // agent response completion and user's next message).
  // Includes sessionType to bridge the gap between agent-loop turns: the `done`
  // event clears chatIsStreaming, but the session is still active until
  // doSessionCleanup runs. Without this, bubbleRole briefly falls through to
  // the 'teacher' idleText case, causing a visible flash.
  const isInLiveFlow = !!(speakingAgentId || thinkingState || chatIsStreaming || sessionType);

  // ---- phase ----
  // Live flow states MUST be checked before playbackCompleted so that
  // starting a QA from the completed state doesn't leak the restart icon
  // into agent bubbles.
  let phase: PlaybackPhase;
  if (isCueUser) {
    phase = 'cueUser';
  } else if (isTopicPending) {
    phase = 'discussionPaused';
  } else if (speakingAgentId || thinkingState || chatIsStreaming || sessionType) {
    phase = 'discussionActive';
  } else if (discussionTrigger) {
    phase = 'waitingProactive';
  } else if (playbackCompleted) {
    phase = 'completed';
  } else if (engineMode === 'playing') {
    phase = 'lecturePlaying';
  } else if (engineMode === 'paused') {
    phase = 'lecturePaused';
  } else {
    phase = 'idle';
  }

  // ---- sourceText (without userMessage — Roundtable overlays that locally) ----
  let sourceText: string;
  if (liveSpeech) {
    sourceText = liveSpeech;
  } else if (isInLiveFlow) {
    // In live flow but no text yet — show empty (loading dots handled by bubble)
    sourceText = '';
  } else if (lectureSpeech) {
    sourceText = lectureSpeech;
  } else if (phase === 'completed') {
    sourceText = '';
  } else {
    sourceText = idleText || '';
  }

  // ---- bubble loading states ----
  const isBubbleLoading = !!(speakingAgentId && !liveSpeech);
  const isAgentLoading = !!(speakingStudent && !liveSpeech);

  // ---- activeRole ----
  let activeRole: 'teacher' | 'agent' | 'user' | null;
  if (liveSpeech && speakingStudent) {
    activeRole = 'agent';
  } else if (liveSpeech) {
    activeRole = 'teacher';
  } else if (isAgentLoading) {
    activeRole = 'agent';
  } else if (isBubbleLoading) {
    activeRole = 'teacher';
  } else if (isCueUser) {
    activeRole = null;
  } else if (lectureSpeech) {
    activeRole = 'teacher';
  } else {
    activeRole = null;
  }

  // ---- bubbleRole ----
  let bubbleRole: 'teacher' | 'agent' | 'user' | null;
  if (liveSpeech && speakingStudent) {
    bubbleRole = 'agent';
  } else if (liveSpeech) {
    bubbleRole = 'teacher';
  } else if (isAgentLoading) {
    bubbleRole = 'agent';
  } else if (isBubbleLoading) {
    bubbleRole = 'teacher';
  } else if (isInLiveFlow) {
    bubbleRole = null;
  } else if (isCueUser) {
    bubbleRole = null;
  } else if (lectureSpeech || idleText) {
    bubbleRole = 'teacher';
  } else {
    bubbleRole = null;
  }

  // ---- buttonState ----
  let buttonState: BubbleButtonState;
  if (isTopicPending) {
    buttonState = 'play'; // resume topic
  } else if (phase === 'lecturePlaying') {
    buttonState = 'bars'; // breathing bars + hover pause
  } else if (phase === 'discussionActive') {
    buttonState = 'bars';
  } else if (phase === 'completed') {
    buttonState = 'restart';
  } else if (phase === 'idle' || phase === 'lecturePaused') {
    buttonState = 'play';
  } else {
    buttonState = 'none';
  }

  // ---- isTopicActive ----
  const isTopicActive =
    chatIsStreaming || isTopicPending || isCueUser || engineMode === 'live' || !!discussionTrigger;

  return {
    phase,
    sourceText,
    bubbleRole,
    activeRole,
    buttonState,
    isInLiveFlow,
    isTopicActive,
  };
}
