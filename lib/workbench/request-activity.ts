import type { ChatNode, SessionStatus } from './session-store';

/**
 * The request preview's ADAPTER: the one place that reads the conversation for
 * the right-hand panel shown before a course has its first scene.
 *
 * It projects the session fold's own chat nodes — the same durable events the
 * conversation renders, so a cold replay and a live stream give the same
 * answer — into a timestamped track of what this request actually did: its
 * tool calls with their real arguments and times, the agent's plan text, the
 * `ask_user` question and its answer, and the first persisted page. It invents
 * nothing. Deciding what is on screen at a given instant is the pure
 * scheduler's job (`request-schedule.ts`).
 */

const LIVE_STATUSES: readonly SessionStatus[] = ['running', 'queued', 'connecting'];

/** The fold's durable steer receipt keeps the message inside the current request. */
export function requestStartIndex(chat: readonly ChatNode[]): number {
  return chat.findLastIndex(
    (node, index) =>
      node.kind === 'user' &&
      !(
        chat[index + 1]?.kind === 'system' &&
        chat[index + 1]?.copyKey === 'workbench.system.steerQueued'
      ),
  );
}

const QUIET_KINDS = new Set<ChatNode['kind']>(['system', 'waiting', 'course']);

/**
 * Where the current request began. Answering the agent's question (the plan
 * confirmation) continues the request that asked it rather than starting a
 * new one, so the preview keeps its stages across the answer.
 */
export function requestEpisodeStart(chat: readonly ChatNode[]): number {
  let start = requestStartIndex(chat);
  while (start > 0) {
    let before = start - 1;
    while (before >= 0 && QUIET_KINDS.has(chat[before].kind)) before -= 1;
    if (before < 0 || chat[before].kind !== 'question') break;
    const asked = requestStartIndex(chat.slice(0, before));
    if (asked < 0) break;
    // A question asked after a page was persisted is a follow-up about a
    // course that exists, not part of making it: the answer starts its own
    // request. (A course created before a question still stays with it.)
    if (chat.slice(asked, before).some((node) => node.kind === 'tool' && Boolean(node.sceneId))) {
      break;
    }
    start = asked;
  }
  return start;
}

export interface RequestStep {
  /** The tool card itself, for presentation. */
  readonly node: ChatNode;
  readonly id: string;
  readonly tool: string;
  readonly ts: number;
  readonly endedAt?: number;
  readonly failed: boolean;
  /** Page order, for per-page tools. */
  readonly order?: number;
  /** The scene this call persisted, once its checkpoint landed. */
  readonly sceneId?: string;
}

export interface RequestQuestion {
  readonly node: ChatNode;
  readonly ts: number;
  /** The agent's own reply text right before it asked — usually the plan. */
  readonly planText: string | null;
  readonly answeredAt: number | null;
}

/** The agent thinking or replying: the text it is producing, as it streams. */
export interface RequestThought {
  readonly node: ChatNode;
  readonly ts: number;
}

export interface RequestTrack {
  /** Names this request: the key of the message that opened it. */
  readonly key: string;
  readonly startedAt: number;
  readonly prompt: string;
  readonly steps: readonly RequestStep[];
  readonly thoughts: readonly RequestThought[];
  /** Every question the agent asked in this request, in order. */
  readonly questions: readonly RequestQuestion[];
  /** The request's latest question to the user, open or answered. */
  readonly question: RequestQuestion | null;
  /** When this request's first page was persisted. */
  readonly firstSceneAt: number | null;
  /** A run is in flight, or an open question waits for the user. */
  readonly live: boolean;
  /** The newest timestamp in the request; a live clock never runs behind it. */
  readonly lastTs: number;
}

const PAGE_TOOLS = new Set(['generate_scene', 'generate_tts', 'generate_actions']);

function nodeTimes(node: ChatNode): number[] {
  return [node.at, node.startedAt, node.endedAt, node.toolStartedAt, node.toolEndedAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

/**
 * The current request as a timestamped track, or null when there is nothing
 * to preview: no request yet, or a replay still rebuilding history.
 */
export function requestTrack(
  chat: readonly ChatNode[],
  status: SessionStatus,
  replaying: boolean,
  /**
   * The session's own prompt from the control plane. A new session waiting in
   * the runner's queue has no events yet, so this is the only record of its
   * request until `session_start` paints the opening bubble.
   */
  sessionPrompt: string | null = null,
): RequestTrack | null {
  if (replaying) return null;
  const start = requestEpisodeStart(chat);
  if (start < 0) {
    // Only a just-created session is queued with nothing folded; attaching to an
    // existing one starts at `connecting` and replays its own events.
    if (chat.length > 0 || !sessionPrompt || status !== 'queued') return null;
    return {
      key: 'queued',
      startedAt: 0,
      prompt: sessionPrompt,
      steps: [],
      thoughts: [],
      questions: [],
      question: null,
      firstSceneAt: null,
      live: true,
      lastTs: 0,
    };
  }
  const nodes = chat.slice(start);
  const opening = nodes[0];
  const allTimes = nodes.flatMap(nodeTimes);
  const startedAt = opening.at ?? (allTimes.length > 0 ? Math.min(...allTimes) : 0);
  let clock = startedAt;
  let lastTs = startedAt;
  const steps: RequestStep[] = [];
  const thoughts: RequestThought[] = [];
  const questions: RequestQuestion[] = [];
  let question: RequestQuestion | null = null;
  let lastReply: string | null = null;
  let firstSceneAt: number | null = null;

  for (const node of nodes) {
    for (const time of nodeTimes(node)) lastTs = Math.max(lastTs, time);
    if (node.kind === 'assistant' && node.text.trim()) lastReply = node.text;
    if (node.kind === 'assistant' || node.kind === 'thinking') {
      const ts = node.at ?? node.startedAt ?? clock;
      clock = Math.max(clock, ts);
      if (node.text.trim()) thoughts.push({ node, ts });
      continue;
    }
    if (node.kind === 'user' && node !== opening) {
      if (node.at !== undefined) clock = Math.max(clock, node.at);
      const asked = question as RequestQuestion | null;
      // The fold decides what answers a question (a textless attachment does
      // not), so the preview and the chat cannot disagree; the answer's time
      // is that of the first message with words after it.
      if (asked && asked.answeredAt === null && asked.node.questionAnswered && node.text.trim()) {
        question = { ...asked, answeredAt: node.at ?? clock };
        questions[questions.length - 1] = question;
      }
      continue;
    }
    if (node.kind === 'question') {
      const ts = node.at ?? clock;
      clock = Math.max(clock, ts);
      question = {
        node,
        ts,
        planText: lastReply,
        // The answer is the user message that follows, below.
        answeredAt: null,
      };
      questions.push(question);
      lastReply = null;
      continue;
    }
    if (node.kind !== 'tool' || !node.toolName) continue;
    // The question card is the question; its tool card repeats it.
    if (node.toolName === 'ask_user') continue;
    const ts = node.toolStartedAt ?? clock;
    clock = Math.max(clock, ts);
    const settled = node.toolState === 'done' || node.toolState === 'failed';
    const endedAt = settled ? (node.toolEndedAt ?? ts) : undefined;
    const order = node.toolArgs?.order;
    steps.push({
      node,
      id: node.toolCallId || node.key,
      tool: node.toolName,
      ts,
      ...(endedAt !== undefined ? { endedAt } : {}),
      failed: node.toolState === 'failed',
      ...(PAGE_TOOLS.has(node.toolName) && typeof order === 'number' ? { order } : {}),
      ...(node.sceneId ? { sceneId: node.sceneId } : {}),
    });
    if (node.sceneId && firstSceneAt === null) firstSceneAt = endedAt ?? lastTs;
  }

  if (question?.node.questionAnswered && question.answeredAt === null) {
    question = { ...question, answeredAt: lastTs };
    questions[questions.length - 1] = question;
  }
  const questionOpen = !!question && question.answeredAt === null;
  // A message the runner has not picked up yet (the plan's answer, or a new
  // request between runs) is still this request moving, though the session
  // status catches up only when the run starts. The fold's gap indicator is
  // exactly that fact: it opens with the message and closes when the run
  // produces something or ends.
  const awaitingRun = nodes.at(-1)?.kind === 'waiting';
  return {
    key: opening.key,
    startedAt,
    prompt: opening.text,
    steps,
    thoughts,
    questions,
    question,
    firstSceneAt,
    live: LIVE_STATUSES.includes(status) || questionOpen || awaitingRun,
    lastTs,
  };
}
