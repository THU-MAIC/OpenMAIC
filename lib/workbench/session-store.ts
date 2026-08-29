'use client';

/**
 * Workbench session store — the browser's fold over a PR1 agent-runtime job's
 * durable event log (`/api/agent/sessions/:id/events`).
 *
 * Ported from the spike's `lib/workbench/session-store.ts` and adapted to the
 * PR1 control plane: the event shapes are the runner's (`PersistedEvent` in
 * `lib/server/agent-runtime/session-store.ts`), the endpoints are the app's own
 * routes, and the spike-only event types are gone because PR1 does not emit
 * them.
 *
 * Two properties are inherited unchanged, and neither is decoration:
 *
 *  - **The rendered UI is a pure function of the applied event prefix.** The
 *    fold (`foldEvent`) is a pure function exported for tests; no event handler
 *    queries the session status endpoint. That is what makes `Last-Event-ID`
 *    resumption correct rather than approximately correct: reattaching at N and
 *    applying N+1… produces the same state as applying 1… from scratch.
 *  - **It lives outside React.** Unmounting the chat tree tears down the
 *    EventSource; the folded state survives here, and reattaching resumes from
 *    `lastEventId` instead of replaying the whole run.
 */
import { create } from 'zustand';
import { isSkillLoadTool, skillLoadId } from './skill-load';
import { defaultWorkbenchTranslator, type WorkbenchCopyKey } from '@/lib/i18n/workbench';
import { parseElementRefs, type ElementRef } from './element-refs';
import { parseCourseRefs, type CourseRef } from './course-refs';
import { appendCourseSighting, courseSightingsOf } from './run-courses';

export type ChatNodeKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'system'
  | 'tool'
  | 'boundary'
  /**
   * The classrooms ONE EXCHANGE produced or was pointed at, as things you can
   * click.
   *
   * Folded at that exchange's `agent_end`, so the cards sit at the tail of the
   * answer they belong to — the artifact-card pattern: what an answer produced,
   * named, where the answer ends. An EXCHANGE is one question and its answer
   * (`agent_start` … `agent_end`), NOT a pi `turn`: a single answer routinely
   * spans ten turns, and flushing per turn ended it with ten identical cards.
   *
   * `stageIds` is that exchange's own ordered, de-duplicated set (see
   * `lib/workbench/run-courses` for what counts as an appearance and why reader
   * tools do not). De-duplicated WITHIN an exchange, deliberately NOT across
   * them: ask again about the same course and that answer earns its own card.
   *
   * An EMPTY (or absent) `stageIds` is the legacy unbound row: a v1 transcript's
   * page checkpoint carried no stageId at all, and the renderer falls back to the
   * session's own stage (see `WorkbenchState.stageId`).
   *
   * It is NOT an origin badge and NOT an association — it names classrooms and
   * offers to put them on screen, and says nothing about which chat owns what.
   */
  | 'course'
  /**
   * The LLM-gap indicator (the thinking row): open while the agent's next call is in
   * flight with nothing on screen yet, removed the moment the first content
   * arrives. Produced and closed ONLY by the event stream (replay-safe); it
   * never survives its gap.
   */
  | 'waiting'
  /**
   * The agent asked the user something and stopped (`ask_user` is terminal for
   * the run — see `LIFECYCLE.userQuestion`). The card carries the complete
   * question envelope, and its ANSWERED flag is derived, not received: the
   * answer channel is the ordinary message channel with no correlation id, so
   * "any user message later on the timeline" is the only fact there is (see
   * `answerOpenQuestions`). Nothing about the card is stored outside the fold,
   * which is what makes a replayed log paint a historical question as already
   * answered instead of offering buttons for a decision the user made an hour
   * ago.
   */
  | 'question';

/**
 * How loud a timeline marker is allowed to be. System notices are the chat's
 * quietest register (a small icon and a line of muted text). `error` is the one
 * that may raise its voice — a tinted notice card, not red prose — because a
 * failed session that reads like every other breadcrumb is a failure the user
 * scrolls past.
 */
export type SystemTone = 'info' | 'success' | 'error';

/** One choice offered by `ask_user`, exactly as the tool validated it. */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface ChatNode {
  key: string;
  kind: ChatNodeKind;
  text: string;
  /** Product-owned copy resolved at render time; `text` is the zh fallback. */
  copyKey?: WorkbenchCopyKey;
  /** User nodes only: display names from `user_message.data.materials`. */
  materials?: string[];
  /**
   * User nodes only: the slide elements the message pointed at, from
   * `user_message.data.elementRefs`. Read from the durable event so a replayed
   * transcript shows the same pills a live send did — nothing about a reference
   * is reconstructed locally.
   */
  elementRefs?: ElementRef[];
  /**
   * User nodes only: the courses the message named with `@`, from
   * `user_message.data.courseRefs`. Same durable-first rule as `elementRefs` —
   * the bubble's receipt is read back from the log, never reconstructed.
   */
  courseRefs?: CourseRef[];
  /** Assistant / thinking nodes only: still receiving deltas. */
  streaming?: boolean;
  /** System markers only. */
  tone?: SystemTone;
  /**
   * Course rows only: the classrooms this exchange produced or was pointed at, in
   * first-seen order within the exchange. Absent (or empty) on the legacy unbound
   * row, where the renderer falls back to the session's own stage.
   */
  stageIds?: readonly string[];
  /**
   * System notices only: the raw technical cause, verbatim (a provider error
   * string, a config assertion, a gateway status). It is NEVER part of the
   * sentence — the notice shows a human summary and keeps this behind a
   * disclosure. Concatenating it into `text` is what made a failed run read
   * like a console line (the failure text and its retry hint welded into one
   * run-on sentence), and made two failures with the same cause impossible to
   * recognise as the same fact.
   */
  detail?: string;
  /**
   * System notices only: what the user can DO about it, one short clause on
   * its own line. Separate from `text` so the summary stays a statement of
   * what happened and the advice can change without rewriting it.
   */
  hint?: string;
  /** Product-owned hint resolved at render time. */
  hintCopyKey?: WorkbenchCopyKey;
  /** Thinking bars only: wall-clock bounds for the "thought for Ns" summary. */
  startedAt?: number;
  endedAt?: number;
  /** Tool cards only. */
  toolCallId?: string;
  toolName?: string;
  /**
   * The call's arguments as the STRUCTURE the agent sent, not a truncated JSON
   * snippet of it. Keeping the object lets the presentation layer render the
   * localized "generating page N" label and still show the exact wire format,
   * pretty-printed, when
   * the card is opened.
   */
  toolArgs?: Record<string, unknown>;
  toolState?: 'running' | 'done' | 'failed';
  /**
   * The tool's own STRUCTURED result (`details` on the pi tool result). Every
   * course tool returns one — `{courseTitle, pages}` for an outline,
   * `{order, title}` for a page — and it is a far better basis for a human
   * summary than parsing the prose the model is meant to read. See
   * `components/workbench/chat/tool-presentation.ts`.
   */
  toolDetails?: unknown;
  /** The tool's text result, in full (capped only to bound memory). */
  toolResultText?: string;
  /** The memory cap clipped the raw result; presentation adds a localized marker. */
  toolResultTruncated?: boolean;
  /** Synthetic product-owned result resolved at render time. */
  toolResultCopyKey?: WorkbenchCopyKey;
  /** Event timestamps, so a card can report how long the call took. */
  toolStartedAt?: number;
  toolEndedAt?: number;
  /**
   * The tool's live progress lines (PR5: the running card's scrollable
   * micro-window). `trace` events are emitted from INSIDE a running tool
   * (`generate_scene` is two multi-minute LLM round trips), so they are that
   * call's progress, not independent events in the conversation. They land on
   * the card that is running; a bounded ring, oldest dropped first.
   */
  toolTraces?: string[];
  /** Tool cards only: the scene this call produced, once its checkpoint lands. */
  sceneId?: string;
  /**
   * Question cards only: the choices the agent offered, or absent for an open
   * question (the composer below the card is the answer box).
   */
  questionOptions?: QuestionOption[];
  /** Question cards only: several options may be picked at once. */
  questionMultiSelect?: boolean;
  /**
   * Question cards only, DERIVED: a user message landed after this card, so the
   * question has had its answer and the card is history. Not a received field —
   * see `answerOpenQuestions`.
   */
  questionAnswered?: boolean;
}

export interface PlannedPage {
  order: number;
  title: string;
  type: string;
  widgetType?: string;
}

export interface BuiltPage {
  order: number;
  title?: string;
  sceneId?: string;
  sceneType?: string;
  excerpt?: string;
  elementCount?: number;
}

/**
 * How the attached run is doing — plus one value for having no run at all.
 *
 * `idle` IS THAT VALUE: the store holds no session, because nothing has been
 * attached yet or the user is in a DRAFT conversation whose first message will
 * create one. It is not a run state and the fold never produces it (`attach()`
 * moves straight to `connecting`), and it exists because "there is no run" had no
 * honest value before. The initial status was `connecting`, so every surface that
 * asks "is a run in flight" — the composer's STOP button, its interrupt
 * placeholder, the suppressed idle empty state — said yes about a conversation
 * that did not exist. All of them test a WHITELIST of the live statuses, so this
 * value needs no special case anywhere: it is simply on none of those lists.
 */
export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * The base key of the LEGACY unbound course row (a v1 page checkpoint carried no
 * stageId). There is at most one of those per session, so the bare constant is
 * its whole key. Every other course row is one exchange's card set and keys on
 * the `agent_end` event that flushed it, which is deterministic from the log.
 */
export const COURSE_NODE_KEY = 'course-deck';

/** The fold's half of the store: everything `foldEvent` may read or write. */
export interface WorkbenchFold {
  status: SessionStatus;
  lastEventId: number;
  error: string | null;
  courseTitle: string | null;
  /** The session's own prompt, fetched from the control plane on attach —
   * it is the header title until the event log (or an outline) provides
   * something better, including the queued window before `session_start`. */
  sessionPrompt: string | null;
  /**
   * The name the user gave this conversation, if any. An OVERRIDE over the
   * derived title, not a replacement for the prompt — clearing it restores the
   * derived one. Like `sessionPrompt` it comes from session meta rather than
   * from the event log: a rename is not something the run did.
   */
  sessionTitle: string | null;
  skillId: string | null;
  skillViolations: string[];
  plan: PlannedPage[];
  pages: Record<number, BuiltPage>;
  chat: ChatNode[];
  /**
   * Bumped whenever the run changed the shape of the owner's course LIBRARY —
   * a stage created, a folder created, a course filed (`library_changed`). The
   * workspace's course tree answers an increase by refetching its authoritative
   * list, which is how an agent-created course or folder appears in the left rail
   * without a page reload.
   *
   * A counter rather than a flag: the fold has to be a pure function of the
   * applied event prefix, so "how many library writes has this session made"
   * replays exactly while "is there a pending refresh" would not. What changed
   * is deliberately not folded — the consumer refetches the whole list, so a
   * diff would be state that can go stale in a way the list cannot.
   */
  libraryRevision: number;
  /**
   * Stage ids seen in `stage_link` events (legacy `course_link` accepted on
   * replay), in first-seen order. The workspace records how many came from the
   * attach backlog and may open only later live arrivals. Repeated links stay
   * recorded but cause no navigation, so manually leaving a course is respected.
   */
  stageLinkStageIds: readonly string[];
  /**
   * Stage ids whose courses a checkpoint wrote to, in first-seen order. This is
   * the real-time-sync unlock for courses the session did NOT mint: a user can
   * open an existing course from a URL and the agent can keep patching it with
   * an explicit stageId — no `stage_link` is ever emitted for it, so
   * `stageLinkStageIds` stays empty, but each checkpoint's `stageId` proves
   * the attached agent owns what is on screen. Unlike `stageLinkStageIds`,
   * touched ids never open anything: a checkpoint is not the first-seen
   * navigation signal.
   */
  touchedStageIds: readonly string[];
  /**
   * The classrooms sighted since the last exchange boundary, in first-seen order.
   *
   * A BUFFER, not a record: `agent_end` drains it into one `course` row at the
   * tail of that answer and leaves it empty again. It is the whole of the
   * per-exchange card rule's state, which is what keeps a cold replay identical to
   * the live fold — the buffer is a pure function of the applied prefix like
   * everything else here, and the flush is a deterministic point in the log rather
   * than a wall-clock or render-time decision.
   *
   * WHY `agent_end` AND NOT `turn_end`. An exchange is one question and its
   * answer. pi's `turn` is one assistant message plus its tool calls, and a single
   * answer routinely spans ten of them — "write me ten pages" is ten turns against
   * one classroom, which flushed per turn ended the answer with ten identical
   * cards. A run interrupted mid-answer emits no `agent_end`, so its sightings
   * survive in here and land at the resumed run's flush: one card set per answer,
   * even when the answer took two workers to finish.
   *
   * It deliberately spans the gap BEFORE a run opens. A `user_message` is written
   * by the control plane outside any run, so a classroom the user `@`-named lands
   * here first and is flushed at the end of the answer to it. A run that dies
   * without ever reaching `agent_end` — a plain failure — therefore paints no
   * card: nothing was produced to point at, and the user's own bubble already
   * shows the `@` pill. A run that is interrupted and repaired and then stopped
   * (`session_end` cancelled) is different: the answer's sightings survive the
   * repair, so the cancelled terminal flush paints the card set (see `agent_end`
   * and `session_end`).
   *
   * See `lib/workbench/run-courses` for what counts as a sighting.
   */
  runCourseStageIds: readonly string[];
  /**
   * The page order the agent is generating right now, folded from the
   * `generate_scene` tool card. The course pane reads it to mark that page as
   * in-progress.
   */
  generatingOrder: number | null;
  panelOpen: boolean;
  panelPinned: boolean;
  /**
   * Key of the in-flight assistant message's thinking node, if one has been
   * folded. pi streams one assistant message as many `message_update` events,
   * each carrying the FULL content so far (thinking + text); this pointer is
   * how later updates find the node the earlier ones created instead of
   * appending a second bar. Reset by `message_start` / a new run AND by
   * `message_end`: the message's final snapshot arrives ON `message_end`
   * itself (pi emits no updates after it), so the gate can close and later
   * frames cannot append a second bubble after a tool card. Kept in the fold
   * so a replayed log rebuilds it deterministically.
   */
  thinkingKey: string | null;
  /** Key of the in-flight assistant text node. Same lifetime as `thinkingKey`. */
  assistantKey: string | null;
  /**
   * OpenPBL `part.upserted` gate: a new thinking/text node may be created only
   * while the current LLM generation is open. `message_end` / `session_end`
   * close it, so late `message_update`s cannot append a second bubble after a
   * tool card.
   */
  generationOpen: boolean;
  /**
   * Fold-local run fence. `attempt` is only a consecutive-failure counter: a
   * clean finish/requeue resets it to 0, so it is NOT a lifetime generation.
   * Safety therefore depends on every run's first durable event being a
   * lifecycle frame. Only lifecycle frames may move this epoch (including
   * downward after a reset). Once anchored, ordinary runner frames must match
   * it exactly; before the first anchor (`epoch === 0`) the first positive
   * attempt remains provisionally admissible for backward compatibility.
   * Control-plane events (`attempt === 0`) are exempt. 0 = no runner anchor
   * seen yet.
   */
  epoch: number;
  /** Key of the open waiting node, if the timeline is currently in an LLM gap. */
  waitingKey: string | null;
  /**
   * A steered user message is owed an answer but the current step is still
   * active. Kept for fold compatibility; waiting itself only mounts before
   * the turn has any part (OpenPBL: before its first character).
   */
  waitingArmed: boolean;
  /**
   * The session's original/attached stage metadata. Course tools do not use it
   * as a default target; the classroom pane remains independent UI state.
   */
  stageId: string | null;
}

/**
 * The store's DATA half: the fold, plus the flags that are scoped to one
 * attached session but are not folded from its log.
 *
 * Split out from `WorkbenchState` so "everything that belongs to a session" has
 * a name, and so `createInitialSessionState()` can be typed as ALL of it. A new
 * field lands in one of these two interfaces, which is what makes the reset
 * below total by construction rather than by remembering.
 */
export interface WorkbenchSessionState extends WorkbenchFold {
  sessionId: string | null;
  attached: boolean;
  /**
   * Changes whenever this client makes a title decision. A detail request
   * captures it so an older response cannot overwrite a rename (including an
   * explicit clear) made while that request was in flight.
   */
  sessionTitleRevision: number;
  /** True until the replayed backlog is exhausted; the UI says "catching up". */
  replaying: boolean;
  /**
   * How many leading `stageLinkStageIds` came from the durable backlog that was
   * replayed while this session attached.
   *
   * Those links belong in the transcript, but opening an old chat is not an
   * instruction to mutate the independent classroom pane. Only links appended
   * after this baseline are live arrivals that may add a classroom tab.
   */
  replayedStageLinkCount: number;
  /**
   * Full-screen playback (the canvas pager / preview toolbar play action): the
   * workspace's other panes step aside and the classroom plays full-bleed.
   * Ephemeral UI state; the fold survives in this store, so returning restores
   * the conversation and the pane exactly.
   */
  playbackOn: boolean;
}

export interface WorkbenchState extends WorkbenchSessionState {
  /**
   * Attach to a session. `stageId` is the session's own stage when the caller
   * already knows it (the sessions list, the creation response); a deep link
   * that carries only `?session=` passes null and the meta fetch in
   * `useWorkbenchStream` fills it.
   */
  attach: (sessionId: string, stageId: string | null) => void;
  /**
   * Hold NO session: the authoritative reset. See `createInitialSessionState`.
   */
  detach: () => void;
  /**
   * Whether the classroom pane is expanded. The WORKSPACE owns this now (the
   * pane's openness is a URL fact), and writes it here so `Stage` can tell
   * whether a human can actually see the surface it holds an edit lease on.
   * `byUser` pins the choice, so the fold's auto-opener stops competing.
   */
  setPanelOpen: (open: boolean, byUser?: boolean) => void;
  setPlaybackOn: (on: boolean) => void;
  applyEvent: (event: WorkbenchEvent) => void;
  applyEvents: (events: readonly WorkbenchEvent[]) => void;
  setAttached: (attached: boolean) => void;
  setReplaying: (replaying: boolean) => void;
  /** Atomically closes replay and records its stage-link navigation baseline. */
  finishReplay: () => void;
  setError: (error: string | null) => void;
  setSessionPrompt: (prompt: string | null) => void;
  /**
   * The rename's optimistic write, and its rollback: the caller sets the new
   * title, PATCHes, and puts the old one back if the write is refused.
   */
  setSessionTitle: (title: string | null) => void;
  /** Seed title / stage / idle status from session meta before any events arrive. */
  setSessionBootstrap: (input: {
    prompt?: string | null;
    title?: string | null;
    expectedTitleRevision?: number;
    status?: SessionStatus;
    stageId?: string | null;
  }) => void;
}

/**
 * One frame of the SSE stream. Mirrors the runner's `PersistedEvent`; the SSE
 * route adds a `phase` marker the hook reads and the fold ignores.
 */
export interface WorkbenchEvent {
  id: number;
  ts: number;
  attempt: number;
  type: string;
  data: unknown;
}

/**
 * THE single source for "this store holds no session".
 *
 * Every field of `WorkbenchSessionState` at NEVER RAN — the store's own initial
 * state, the clean slate `attach()` starts a different session from, and the
 * whole of `detach()`. One object, three call sites, no field lists to keep in
 * sync.
 *
 * WHY IT IS A FUNCTION AND WHY IT IS TOTAL. This bug arrived three times, and
 * every time the same shape: entering a draft conversation (the user pressed
 * new-chat while the previous session was still generating) left ONE run-derived
 * field behind, the UI branched on it, and the fix cleared that one field. First
 * `replaying`, which parked the middle column on a catch-up spinner nothing could
 * turn off. Then `status`, whose `connecting` initial value made
 * `isRunLive` — and therefore the STOP button, the interrupt placeholder and the
 * suppressed empty state — read a nonexistent conversation as a live run. There
 * are twenty-nine such fields, and a hand-written reset per transition is
 * twenty-nine chances to miss one.
 *
 * So the reset is not a list of assignments, it is this object; the return type is
 * the complete state, so a field added to the fold that is not initialised here
 * fails to compile; and `tests/workbench/draft-conversation-reset.test.ts` walks
 * the live store's keys against it, so a field added to the store but not to this
 * factory fails there.
 *
 * A FUNCTION rather than a constant because the arrays and the record are
 * mutable-by-type: one shared literal would let a fold hand the next session the
 * previous one's `chat` array.
 */
export function createInitialSessionState(): WorkbenchSessionState {
  return {
    // ── Attachment ──────────────────────────────────────────────────────
    sessionId: null,
    attached: false,
    sessionTitleRevision: 0,
    // Nothing is attached, so there is nothing to replay. It used to be `true`
    // here, which is only ever read as "keep the catch-up spinner up" — and with
    // no session nothing would ever turn it off again (the stream hook returns
    // early without one). That is the infinite spinner a new conversation landed
    // in. `attach()` arms it explicitly instead.
    replaying: false,
    replayedStageLinkCount: 0,
    playbackOn: false,
    // ── The run ─────────────────────────────────────────────────────────
    // No session, no run: `idle` is what keeps the composer on SEND with its
    // ordinary placeholder and lets the idle empty state own the rail.
    // `attach()` moves to `connecting`, which IS live — a session whose log has
    // not arrived yet is presumed running, so the button does not flash SEND
    // before flipping to STOP.
    status: 'idle',
    lastEventId: 0,
    error: null,
    epoch: 0,
    // ── What the run produced ───────────────────────────────────────────
    courseTitle: null,
    sessionPrompt: null,
    sessionTitle: null,
    skillId: null,
    skillViolations: [],
    plan: [],
    pages: {},
    chat: [],
    libraryRevision: 0,
    stageLinkStageIds: [],
    touchedStageIds: [],
    runCourseStageIds: [],
    generatingOrder: null,
    // ── In-flight markers ───────────────────────────────────────────────
    thinkingKey: null,
    assistantKey: null,
    generationOpen: false,
    waitingKey: null,
    waitingArmed: false,
    // ── Panes ───────────────────────────────────────────────────────────
    panelOpen: false,
    panelPinned: false,
    stageId: null,
  };
}

/**
 * The panel's expanded state, remembered.
 *
 * Per session rather than globally: "I want the classroom out" is a statement
 * about the course being built, and the next session starts as a conversation
 * again like every other one. Written only on a deliberate toggle — the
 * automatic opener must not silently become a preference.
 */
const panelKey = (sessionId: string) => `workbench.panel.${sessionId}`;

function readPanelPreference(sessionId: string): Partial<WorkbenchFold> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(panelKey(sessionId));
    if (raw !== 'open' && raw !== 'closed') return {};
    return { panelOpen: raw === 'open', panelPinned: true };
  } catch {
    return {};
  }
}

function writePanelPreference(sessionId: string, open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(panelKey(sessionId), open ? 'open' : 'closed');
  } catch {
    /* a private-mode browser is allowed to forget */
  }
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface AssistantRunResult {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * pi reports a provider failure before the runner's `session_end`: first as
 * the stream's `error` update, then on the final assistant message (and again
 * on the turn / agent boundary). Folding that first durable frame is what
 * stops the workbench from presenting a dead run as live while settlement is
 * still catching up.
 */
function runErrorOf(data: Record<string, unknown>): string | null {
  const update = data.assistantMessageEvent as
    | { type?: string; reason?: string; errorMessage?: string }
    | undefined;
  if (update?.type === 'error' && update.reason === 'error') {
    return update.errorMessage || 'agent run failed';
  }

  const candidates: unknown[] = [data.message];
  if (Array.isArray(data.messages)) candidates.push(data.messages[data.messages.length - 1]);
  for (const candidate of candidates) {
    const message = candidate as AssistantRunResult | undefined;
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      return message.errorMessage || 'agent run failed';
    }
  }
  return null;
}

function isAssistantMessage(message: unknown): boolean {
  return (message as { role?: string } | undefined)?.role === 'assistant';
}

function assistantBlocks(message: unknown): AssistantContentBlock[] {
  const m = message as { role?: string; content?: AssistantContentBlock[] } | undefined;
  if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return [];
  return m.content;
}

function hasStreamingAssistant(chat: ChatNode[]): boolean {
  return (
    streamingAssistantIndex(chat) >= 0 || chat.some((n) => n.kind === 'thinking' && n.streaming)
  );
}

function assistantText(message: unknown): string {
  return assistantBlocks(message)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

/** The model's reasoning, if the provider streams it (pi `ThinkingContent`). */
function assistantThinking(message: unknown): string {
  return assistantBlocks(message)
    .filter((c) => c.type === 'thinking')
    .map((c) => c.thinking ?? '')
    .join('')
    .trim();
}

function toolArgsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The tool's text result, in full.
 *
 * The cap is a memory bound, not a display decision: a session makes a dozen
 * calls, so the fold would otherwise grow without limit for a string that is
 * only ever read inside an expanded card. 20 000 characters is far past the
 * point where the card starts scrolling, so nothing a user would actually read
 * is lost.
 */
const RESULT_TEXT_LIMIT = 20_000;

function resultText(result: unknown): Pick<ChatNode, 'toolResultText' | 'toolResultTruncated'> {
  const parts = (result as { content?: { type?: string; text?: string }[] })?.content ?? [];
  const s = parts
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  return s.length > RESULT_TEXT_LIMIT
    ? { toolResultText: s.slice(0, RESULT_TEXT_LIMIT), toolResultTruncated: true }
    : { toolResultText: s };
}

/** The trace ring's bound per tool card — a memory cap, not a display decision. */
const TRACE_RING_MAX = 200;

/**
 * The pre-token loading dots. Opened when the agent's next LLM call is in
 * flight with nothing on screen, removed the moment the first real part
 * arrives. This is not a thinking bar — thinking only mounts when reasoning
 * text exists. Both directions are pure functions of the event stream.
 */
function hasTurnParts(chat: ChatNode[]): boolean {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const kind = chat[i]?.kind;
    if (kind === 'user' || kind === 'boundary') break;
    if (kind === 'thinking' || kind === 'tool' || kind === 'assistant') return true;
  }
  return false;
}

function openWaiting(next: WorkbenchFold, key: string, ts: number): void {
  if (next.waitingKey) return;
  // OpenPBL: waiting is only "before the first part". Once thinking / a tool /
  // text exists, a later gap must not flash three dots under the turn.
  if (hasTurnParts(next.chat)) return;
  next.chat = [...next.chat, { key, kind: 'waiting', text: '', startedAt: ts }];
  next.waitingKey = key;
}

function closeWaiting(next: WorkbenchFold): void {
  if (!next.waitingKey) return;
  next.chat = next.chat.filter((n) => n.key !== next.waitingKey);
  next.waitingKey = null;
}

/** The index of the in-flight assistant text node, or -1. At most one exists:
    the streaming flag is only ever on the newest one. Steer bubbles can land
    BELOW it mid-stream, so "last node" is not a safe lookup. */
function streamingAssistantIndex(chat: ChatNode[]): number {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i].kind === 'assistant' && chat[i].streaming) return i;
  }
  return -1;
}

/** Prefer the fold pointer so late `message_update`s after `message_end` stay
    on the same node instead of appending a second copy. */
function assistantIndex(chat: ChatNode[], key: string | null): number {
  if (key) {
    const idx = chat.findIndex((n) => n.key === key && n.kind === 'assistant');
    if (idx >= 0) return idx;
  }
  return streamingAssistantIndex(chat);
}

/** The index of the tool card that is running right now, or -1. */
function runningToolIndex(chat: ChatNode[]): number {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i].kind === 'tool' && chat[i].toolState === 'running') return i;
  }
  return -1;
}

/** Close any streaming thinking bars — text starting means the reasoning ended. */
function settleStreamingThinking(chat: ChatNode[], ts: number): ChatNode[] {
  return chat.map((n) =>
    n.kind === 'thinking' && n.streaming ? { ...n, streaming: false, endedAt: ts } : n,
  );
}

/**
 * Retire every question card above a user message that is about to land.
 *
 * `ask_user` has no answer-correlation id on purpose (the answer is simply the
 * next nonblank message through `postUserMessage`), so this is the whole of
 * what the log can tell us: nonblank user text BELOW a question card means that
 * question has been answered — by its buttons, by typing, or by ignoring it
 * and saying something else entirely. All three make the card history, and
 * none of them should leave live buttons on the timeline. A textless material
 * attachment is queued context, not an answer.
 *
 * Being part of the fold rather than a component effect is what makes a cold
 * replay agree with the live session: a historical card is already answered
 * when it is first painted, so it never flashes as clickable.
 */
function answerOpenQuestions(chat: ChatNode[], answerText: unknown): ChatNode[] {
  // A textless user event is an implicit material attachment. It stays queued
  // behind ask_user and must not make the durable question look answered.
  if (!String(answerText ?? '').trim()) return chat;
  if (!chat.some((n) => n.kind === 'question' && !n.questionAnswered)) return chat;
  return chat.map((n) =>
    n.kind === 'question' && !n.questionAnswered ? { ...n, questionAnswered: true } : n,
  );
}

/** The `user_question` payload's options, defensively — a malformed pair is dropped. */
function questionOptionsOf(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map((raw) => {
      const option = raw as { id?: unknown; label?: unknown } | null;
      return {
        id: String(option?.id ?? '').trim(),
        label: String(option?.label ?? '').trim(),
      };
    })
    .filter((option) => option.id && option.label);
}

/**
 * Is this question ALREADY on screen, unanswered?
 *
 * The event carries no call id, so identity has to be its content: the same
 * question text with the same option set (ids, labels and order) and the same
 * pick mode is the same question. A run that crashed after emitting
 * `user_question` and retried can emit it twice; two identical live cards — and
 * two identical pinned panels — would make the user think they were asked two
 * things.
 *
 * Only UNANSWERED cards count. A session that legitimately asks the same
 * question again after being answered gets a new card, which is right: that is a
 * second decision point, not a duplicate frame.
 */
function hasLiveQuestion(chat: readonly ChatNode[], candidate: ChatNode): boolean {
  return chat.some((node) => {
    if (node.kind !== 'question' || node.questionAnswered) return false;
    if (node.text !== candidate.text) return false;
    if (Boolean(node.questionMultiSelect) !== Boolean(candidate.questionMultiSelect)) return false;
    const mine = node.questionOptions ?? [];
    const theirs = candidate.questionOptions ?? [];
    return (
      mine.length === theirs.length &&
      mine.every((option, i) => option.id === theirs[i]?.id && option.label === theirs[i]?.label)
    );
  });
}

/**
 * Settle tool cards that will never see their own `tool_execution_end`.
 *
 * Two run outcomes leave cards mid-flight: a worker dying (the resuming runner
 * names the orphans in `repairedToolCalls`) and a cancel (the loop leaves
 * whatever was in flight behind). Without this they pulse "running" forever,
 * which is the one state a settled run must not still be claiming.
 *
 * Only STILL-RUNNING cards are touched, ever. A card can already carry a real
 * result while its id shows up in the orphan list — the worker died between
 * appending `tool_execution_end` and saving the transcript — and rewriting that
 * success as a synthetic failure would be a lie.
 *
 * `onlyCallIds` narrows to named calls (the resume repair, which knows exactly
 * which calls were orphaned); omitting it settles every running card, which is
 * what a cancel means — the run is over, so nothing in it is still running.
 */
/**
 * A skill load, drawn from the DURABLE MESSAGES rather than from tool events.
 *
 * Loading a skill can be a pre-executed `read`: the runner synthesizes
 * `assistant(toolCall read) → toolResult(SKILL.md)` so a `/handle` the user typed
 * is loaded rather than merely suggested (`lib/server/agent-runtime/skill-preload.ts`).
 * Nothing executes, so pi emits no `tool_execution_*` for it.
 *
 * Deriving the card from the message frames instead of from a pair of side events
 * is what makes it crash-consistent BY CONSTRUCTION: the entry append IS the card's
 * existence condition, so a truncated write cannot leave a card without its call,
 * or a "done" card over a body that never arrived. Three separate attempts to get
 * that right by ordering two extra events failed — the durable state kept not
 * being a prefix of the intended sequence — which is the argument for not having
 * the extra events at all.
 *
 * NARROW ON PURPOSE. Only the skill-load shape is recognised here (`skillLoadId`:
 * a `read` of `<dir>/SKILL.md`), so every other tool keeps drawing its card from
 * `tool_execution_start` exactly as before — including its timing, which for a
 * batch of parallel calls is one card per call as each STARTS, not all at once
 * when the assistant frame lands. A model-issued skill read produces both signals;
 * `tool_execution_start` upserts by `toolCallId` so that is still one card.
 *
 * #2055 (a lost `tool_execution_end` leaving a card spinning) still applies to
 * every other tool. It no longer applies to skill loads, which have no such event.
 */
function skillLoadCallsIn(message: unknown): { id: string; args: { path: string } }[] {
  return assistantBlocks(message).flatMap((block) => {
    const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (call.type !== 'toolCall' || !call.id || call.name !== 'read') return [];
    const path = (call.arguments as { path?: unknown } | undefined)?.path;
    if (typeof path !== 'string') return [];
    if (!skillLoadId({ toolName: 'read', toolArgs: { path } })) return [];
    return [{ id: call.id, args: { path } }];
  });
}

function settleRunningToolCards(
  chat: ChatNode[],
  options: {
    ts: number;
    /** The honest cause, shown as the card's result text. */
    reason: string;
    reasonCopyKey?: WorkbenchCopyKey;
    onlyCallIds?: ReadonlySet<string>;
    /** Called when the settled card was the one writing a page. */
    onGeneratingCardSettled?: () => void;
  },
): ChatNode[] {
  const { ts, reason, reasonCopyKey, onlyCallIds, onGeneratingCardSettled } = options;
  return chat.map((node) => {
    if (node.kind !== 'tool' || node.toolState !== 'running') return node;
    if (onlyCallIds && (!node.toolCallId || !onlyCallIds.has(node.toolCallId))) return node;
    if (node.toolName === 'generate_scene') onGeneratingCardSettled?.();
    return {
      ...node,
      toolState: 'failed' as const,
      toolResultText: reason,
      ...(reasonCopyKey ? { toolResultCopyKey: reasonCopyKey } : {}),
      toolEndedAt: ts,
    };
  });
}

/**
 * The fold. Pure: same event prefix in, same view model out — which is exactly
 * the property a reload-after-replay depends on. Idempotent by construction:
 * an event already folded in is dropped, so a reconnect that overlaps (server
 * replays from `Last-Event-ID`, browser also has it) never double-appends.
 */
export function foldEvent(state: WorkbenchFold, event: WorkbenchEvent): WorkbenchFold {
  if (event.id <= state.lastEventId) return state;
  const lifecycleFrame =
    event.type === 'session_start' ||
    event.type === 'session_resumed' ||
    event.type === 'session_end' ||
    event.type === 'session_interrupted';
  // Fold-local fencing: attempt counts consecutive failures and can reset, so
  // lifecycle frames may establish any positive epoch (including 1 after an
  // earlier epoch 6). Ordinary frames can never re-anchor it: once anchored,
  // their attempt must match exactly, so a late higher-attempt zombie cannot
  // poison a reset-down run. Before any lifecycle anchor, the first positive
  // ordinary frame is accepted for backward compatibility but does not set
  // epoch. Dropped frames still consume seq; control-plane frames
  // (`attempt === 0`) are exempt.
  if (event.attempt > 0 && !lifecycleFrame && state.epoch > 0 && event.attempt !== state.epoch) {
    return { ...state, lastEventId: event.id };
  }
  const next: WorkbenchFold = { ...state, lastEventId: event.id };
  if (event.attempt > 0 && lifecycleFrame) next.epoch = event.attempt;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const key = `e${event.id}`;

  /**
   * The classrooms THIS frame puts in front of the user — computed once, here,
   * for every event type. Two consumers, and the single call site is the point:
   * the per-exchange card buffer below, and the cases that keep their own
   * append-only session-level record of the same ids (`stage_link` ↔
   * `stageLinkStageIds`, writer starts and checkpoints ↔ `touchedStageIds`).
   * Reading the same value in both is what stops "what earns a card" and "what
   * counts as a write" from drifting apart — in particular the reader-tool
   * exclusion, which now exists in exactly one place
   * (`lib/workbench/run-courses`).
   */
  const sighted = courseSightingsOf(event);
  for (const stageId of sighted) {
    next.runCourseStageIds = appendCourseSighting(next.runCourseStageIds, stageId);
  }

  switch (event.type) {
    case 'session_start': {
      next.status = 'running';
      next.thinkingKey = null;
      next.assistantKey = null;
      next.generationOpen = true;
      // The session start emits the user's message and NOTHING else. The
      // worker id the runner also puts on this event is a scheduler fact; it
      // stays in the event log, which is where it belongs. "The build started"
      // is not information either — the user pressed send two seconds ago, and
      // the header already says queued / generating page N.
      //
      // The one exception is the classrooms the creating message named: those
      // are part of what the user said, so the first bubble carries the same
      // receipt any later one does. Same untrusted-log rule as `user_message`
      // (drop mode), and same single source — a session-level list is never
      // consulted for this.
      //
      // A session created WITH opening context (materials or `@`-named
      // classrooms) already has its message on the timeline: the create route
      // persists it as a durable `user_message` — the very write that requeues
      // the session — so the runner's `session_start` prompt would paint the
      // same bubble twice. That durable message is the one true opening bubble
      // (it carries the materials and courseRefs receipts); paint from
      // `session_start` only when no such message precedes it. Sessions
      // created without opening context have no durable message and still need
      // this bubble. `session_start` fires only on the very first run, so a
      // matching user node can only be that durable opening message.
      const startPrompt = String(data.prompt ?? '');
      const lastUser = [...state.chat].reverse().find((node) => node.kind === 'user');
      const openingAlreadyPainted =
        lastUser !== undefined && lastUser.kind === 'user' && lastUser.text === startPrompt;
      if (!openingAlreadyPainted) {
        const startCourseRefs = parseCourseRefs(data.courseRefs);
        next.chat = [
          ...answerOpenQuestions(state.chat, startPrompt),
          {
            key: `${key}-u`,
            kind: 'user',
            text: startPrompt,
            ...(startCourseRefs.length ? { courseRefs: startCourseRefs } : {}),
          },
        ];
      }
      // The first LLM call is now in flight — the gap indicator opens.
      openWaiting(next, `${key}-w`, event.ts);
      break;
    }
    case 'session_resumed': {
      next.status = 'running';
      // A follow-up-driven new run (continuous chat): the user's bubble is
      // already on the timeline from the `user_message` event and the header
      // carries the working state, so the run restart itself is not a row.
      if (data.reason === 'follow_up') {
        // A new run: do not keep writing into the previous reply.
        next.thinkingKey = null;
        next.assistantKey = null;
        next.generationOpen = true;
        // A follow-up run just started: the agent is thinking again.
        openWaiting(next, `${key}-w`, event.ts);
        break;
      }
      // A worker that died mid-tool-call leaves cards that will NEVER see
      // `tool_execution_end`: the new attempt's transcript gets a synthetic
      // error result (`planResume`), but no event is appended for the dead
      // call. `repairedToolCalls` names those call ids; without folding it the
      // cards stay "running" forever. Mark them failed with the honest cause,
      // and clear the generating marker if the dead call was writing a page.
      //
      // Only STILL-RUNNING cards: a worker can also die in the window between
      // appending `tool_execution_end` and saving the transcript, in which
      // case the id lands in `repairedToolCalls` while the card is already
      // done — rewriting that success as a synthetic failure would be a lie.
      const repaired = Array.isArray(data.repairedToolCalls)
        ? new Set((data.repairedToolCalls as unknown[]).map(String))
        : null;
      let chat = state.chat;
      if (repaired && repaired.size > 0) {
        chat = settleRunningToolCards(state.chat, {
          ts: event.ts,
          reason: defaultWorkbenchTranslator('workbench.system.workerInterrupted'),
          reasonCopyKey: 'workbench.system.workerInterrupted',
          onlyCallIds: repaired,
          onGeneratingCardSettled: () => {
            next.generatingOrder = null;
          },
        });
      }
      // A recovery is a real event with a real consequence, so it stays; the
      // attempt counter and the replayed-message count go, for the same reason
      // as the worker id.
      next.chat = [
        ...chat,
        {
          key,
          kind: 'system',
          tone: 'info',
          text: defaultWorkbenchTranslator('workbench.system.resumed'),
          copyKey: 'workbench.system.resumed',
        },
      ];
      openWaiting(next, `${key}-w`, event.ts);
      break;
    }
    case 'session_interrupted': {
      // PR1: the runner parked the job WITHOUT a terminal status (deploy
      // handoff / lease lost). The row stays `running`; another instance will
      // claim it and append `session_resumed`. One quiet line is the right
      // register — the user did nothing and needs to do nothing.
      closeWaiting(next);
      next.waitingArmed = false;
      next.chat = [
        ...next.chat,
        {
          key,
          kind: 'system',
          tone: 'info',
          text: defaultWorkbenchTranslator('workbench.system.recovering'),
          copyKey: 'workbench.system.recovering',
        },
      ];
      break;
    }
    case 'consent_required': {
      // Legacy S6 arbitration events: keep the stream moving, do not paint a card.
      closeWaiting(next);
      break;
    }
    case 'user_message': {
      // The control plane writes this the moment the message is received.
      // `delivery: 'steer'` means a run was live and the runner will inject
      // the message between steps — the quiet line sets that expectation.
      // `delivery: 'queued'` means the session was idle and the message drives
      // a new run; the bubble alone carries it (the header says the rest).
      const messageText = String(data.text ?? '');
      const blockedByQuestion =
        !messageText.trim() &&
        state.chat.some((node) => node.kind === 'question' && !node.questionAnswered);
      const steer = data.delivery === 'steer' && !blockedByQuestion;
      // Two shapes exist in the durable log: structured {path, originalName}
      // and the first PR4 build's string form `materials/x.pdf (display name)`.
      const attachments = Array.isArray(data.materials)
        ? (data.materials as unknown[]).map((m) => {
            if (typeof m === 'string') {
              const match = /^([\s\S]+?)（([\s\S]*)）$/.exec(m);
              return match ? match[2] : m;
            }
            const obj = m as { path?: unknown; originalName?: unknown };
            return obj.originalName ? String(obj.originalName) : String(obj.path ?? '');
          })
        : [];
      // Slide elements the message pointed at. The control plane validates and
      // persists this field; replay still treats the durable log as untrusted so
      // legacy or malformed records fold to [] instead of painting false pills.
      const elementRefs = parseElementRefs(data.elementRefs);
      // Same untrusted-log rule for the courses the message named. The bubble's
      // own receipt is all this becomes — the classrooms themselves reach the
      // timeline through this exchange's card set (`sighted` above), not through a
      // session-level list of what the conversation is "about".
      const courseRefs = parseCourseRefs(data.courseRefs);
      next.chat = [
        ...answerOpenQuestions(state.chat, messageText),
        {
          key,
          kind: 'user',
          text: messageText,
          ...(attachments.length ? { materials: attachments } : {}),
          ...(elementRefs.length ? { elementRefs } : {}),
          ...(courseRefs.length ? { courseRefs } : {}),
        },
        ...(steer
          ? [
              {
                key: `${key}-s`,
                kind: 'system' as const,
                tone: 'info' as const,
                text: defaultWorkbenchTranslator('workbench.system.steerQueued'),
                copyKey: 'workbench.system.steerQueued' as const,
              },
            ]
          : []),
      ];
      // The attachment bubble is the durable pending receipt. No run is
      // admitted while blockedByQuestion, so do not paint a thinking gap or
      // claim that the current run will steer it.
      if (steer) {
        // The current step is still active (the side note says exactly that):
        // opening the gap bar over live streaming text would be a lie, so it
        // is ARMED and opens at the next step boundary instead.
        next.waitingArmed = true;
      } else if (!blockedByQuestion) {
        next.generationOpen = true;
        openWaiting(next, `${key}-w`, event.ts);
      }
      break;
    }
    case 'user_question': {
      // The agent stopped to ask (`ask_user` terminates the run), so the gap
      // indicator has nothing left to wait for — the card IS the run's last
      // word, and the ball is with the user.
      //
      // An empty question is dropped rather than painted as a blank card: the
      // tool rejects one, so the only way to see it is a hand-written or
      // corrupted event, and a card with no question is not an affordance.
      closeWaiting(next);
      next.waitingArmed = false;
      const question = String(data.question ?? '').trim();
      if (!question) break;
      const options = questionOptionsOf(data.options);
      const card: ChatNode = {
        key,
        kind: 'question',
        text: question,
        ...(options.length > 0 ? { questionOptions: options } : {}),
        // Multi-select only means something when there is a set to pick from.
        ...(data.multiSelect && options.length > 0 ? { questionMultiSelect: true } : {}),
      };
      // A retried run can re-emit the same question (no call id to key on), and
      // two identical live cards read as two questions. Keep the first.
      if (hasLiveQuestion(next.chat, card)) break;
      next.chat = [...next.chat, card];
      break;
    }
    case 'material_extraction': {
      // Extraction progress used to be injected as visible system lines
      // ("extracting materials" / "materials extracted" progress lines); screenshot feedback is that
      // this is debug texture, not product copy — the agent's own reply
      // carries what the materials produced. Folded to nothing: the frame
      // still consumes its seq (lastEventId advances) so a replay never
      // re-serves it, and nothing else in the workbench consumes it.
      break;
    }
    case 'trace': {
      // A trace is a running tool's progress, so it lands ON that tool's card
      // — a bounded ring of lines feeding the card's scroll micro-window
      // (PR5). A trace with no call in flight folds to nothing: these
      // messages are the worker's own developer prose, and a stray one in the
      // conversation is debug-log texture, not product copy.
      const message = String(data.message ?? '');
      const idx = runningToolIndex(state.chat);
      next.chat =
        idx >= 0
          ? state.chat.map((n, i) => {
              if (i !== idx) return n;
              const traces = [...(n.toolTraces ?? []), message];
              return {
                ...n,
                toolTraces: traces.length > TRACE_RING_MAX ? traces.slice(-TRACE_RING_MAX) : traces,
              };
            })
          : state.chat;
      break;
    }
    case 'thinking_end': {
      // Durable settle marker from the runner: reasoning handed over to text
      // at this instant. Settling HERE (not on the volatile first text delta)
      // is what makes the bar's duration identical live and after refresh.
      next.chat = settleStreamingThinking(next.chat, event.ts);
      break;
    }
    case 'message_start': {
      // pi also starts/ends toolResult messages. Those are not speech.
      if (!isAssistantMessage(data.message)) break;
      // Resume re-emits start for the in-flight reply: keep the open parts.
      if (hasStreamingAssistant(state.chat) || state.thinkingKey || state.assistantKey) {
        next.generationOpen = true;
        break;
      }
      next.generationOpen = true;
      next.thinkingKey = null;
      next.assistantKey = null;
      next.chat = settleStreamingThinking(state.chat, event.ts);
      openWaiting(next, `${key}-w`, event.ts);
      break;
    }
    case 'message_update': {
      if (!isAssistantMessage(data.message)) break;
      const thinking = assistantThinking(data.message);
      const text = assistantText(data.message);
      if (!thinking && !text) break;
      const canCreate =
        state.generationOpen ||
        next.generationOpen ||
        (!hasTurnParts(state.chat) &&
          (state.status === 'connecting' ||
            state.status === 'running' ||
            state.status === 'queued'));
      let chat = next.chat;
      let thinkingKey = state.thinkingKey;
      if (thinking) {
        if (next.waitingKey) {
          const waitKey = next.waitingKey;
          chat = chat.map((n) =>
            n.key === waitKey
              ? {
                  ...n,
                  kind: 'thinking' as const,
                  text: thinking,
                  streaming: true,
                  startedAt: n.startedAt ?? event.ts,
                }
              : n,
          );
          thinkingKey = waitKey;
          next.waitingKey = null;
        } else {
          const idx = thinkingKey ? chat.findIndex((n) => n.key === thinkingKey) : -1;
          if (idx >= 0) {
            chat = chat.map((n, i) => (i === idx ? { ...n, text: thinking } : n));
          } else if (canCreate) {
            thinkingKey = `${key}-t`;
            chat = [
              ...chat,
              {
                key: thinkingKey,
                kind: 'thinking',
                text: thinking,
                streaming: true,
                startedAt: event.ts,
              },
            ];
          }
        }
      } else if (text) {
        closeWaiting(next);
        chat = next.chat;
      }
      if (text) {
        const streamIdx = assistantIndex(chat, state.assistantKey);
        if (streamIdx >= 0) {
          chat = chat.map((n, i) => (i === streamIdx ? { ...n, text } : n));
          next.assistantKey = chat[streamIdx]?.key ?? state.assistantKey;
        } else if (canCreate) {
          // The bar is NOT settled by the first text frame: that frame is a
          // volatile delta, dropped by replay compaction, and settling here
          // would make a live session show one duration and its refresh
          // another. The runner marks the hand-over with a durable
          // `thinking_end` frame (the primary settle source); the remaining
          // durable boundaries — `message_end`, `tool_execution_start`, a new
          // `message_start`, `session_end` — are the fallback for a run that
          // ends before its own marker lands. All of them replay, so the
          // duration converges (OpenPBL: a part's completion is durable).
          chat = [...chat, { key, kind: 'assistant', text, streaming: true }];
          next.assistantKey = key;
        }
      }
      next.chat = chat;
      next.thinkingKey = thinkingKey;
      break;
    }
    case 'message_end': {
      if (!isAssistantMessage(data.message)) {
        // A pre-executed skill load has no `tool_execution_end` to settle its
        // card — the tool result MESSAGE is the completion, and it is durable.
        // Scoped to skill-load cards so no other tool's settle semantics move.
        const result = data.message as
          | { role?: string; toolCallId?: string; isError?: boolean; content?: unknown }
          | undefined;
        if (result?.role === 'toolResult' && typeof result.toolCallId === 'string') {
          const id = result.toolCallId;
          next.chat = next.chat.map((node) =>
            node.kind === 'tool' &&
            node.toolCallId === id &&
            node.toolState === 'running' &&
            isSkillLoadTool(node)
              ? {
                  ...node,
                  toolState: result.isError ? ('failed' as const) : ('done' as const),
                  toolEndedAt: event.ts,
                }
              : node,
          );
        }
        next.generationOpen = false;
        break;
      }
      const skillLoads = skillLoadCallsIn(data.message);
      if (skillLoads.length > 0) {
        closeWaiting(next);
        next.chat = settleStreamingThinking(next.chat, event.ts);
        const existing = new Set(
          next.chat.flatMap((node) =>
            node.kind === 'tool' && node.toolCallId ? [node.toolCallId] : [],
          ),
        );
        next.chat = [
          ...next.chat,
          ...skillLoads
            .filter((call) => !existing.has(call.id))
            .map(
              (call): ChatNode => ({
                key: `${key}-skill-${call.id}`,
                kind: 'tool',
                text: '',
                toolCallId: call.id,
                toolName: 'read',
                toolArgs: call.args,
                toolState: 'running',
                toolStartedAt: event.ts,
              }),
            ),
        ];
      }
      const thinking = assistantThinking(data.message);
      const text = assistantText(data.message);
      const canCreate =
        state.generationOpen ||
        next.generationOpen ||
        (!hasTurnParts(state.chat) &&
          (state.status === 'connecting' ||
            state.status === 'running' ||
            state.status === 'queued'));
      let chat = next.chat;
      if (thinking && next.waitingKey) {
        const waitKey = next.waitingKey;
        chat = chat.map((n) =>
          n.key === waitKey
            ? {
                ...n,
                kind: 'thinking' as const,
                text: thinking,
                streaming: false,
                startedAt: n.startedAt ?? event.ts,
                endedAt: event.ts,
              }
            : n,
        );
        next.waitingKey = null;
        next.thinkingKey = waitKey;
      } else {
        closeWaiting(next);
        chat = next.chat;
      }
      if (thinking) {
        const idx =
          (next.thinkingKey ?? state.thinkingKey)
            ? chat.findIndex((n) => n.key === (next.thinkingKey ?? state.thinkingKey))
            : -1;
        if (idx >= 0) {
          // The final snapshot ends the bar and freezes its duration. The
          // `??` is the exactly-once guard: if a durable boundary already
          // settled this bar (a tool call taking over, a crash settle), the
          // recorded endedAt is never extended by a later boundary event.
          chat = chat.map((n, i) =>
            i === idx
              ? { ...n, text: thinking, streaming: false, endedAt: n.endedAt ?? event.ts }
              : n,
          );
        } else if (canCreate) {
          chat = [
            ...chat,
            {
              key: `${key}-t`,
              kind: 'thinking',
              text: thinking,
              streaming: false,
              startedAt: event.ts,
              endedAt: event.ts,
            },
          ];
        }
      }
      chat = settleStreamingThinking(chat, event.ts);
      const streamIdx = assistantIndex(chat, next.assistantKey ?? state.assistantKey);
      if (streamIdx >= 0) {
        chat = text
          ? chat.map((n, i) => (i === streamIdx ? { ...n, text, streaming: false } : n))
          : chat.filter((_, i) => i !== streamIdx);
      } else if (text && canCreate) {
        chat = [...chat, { key, kind: 'assistant', text }];
      }
      next.chat = chat;
      next.thinkingKey = null;
      next.assistantKey = null;
      next.generationOpen = false;
      next.waitingArmed = false;
      break;
    }
    case 'tool_execution_start': {
      // The card takes over from the gap indicator.
      closeWaiting(next);
      next.chat = settleStreamingThinking(next.chat, event.ts);
      const toolName = String(data.toolName ?? 'tool');
      // Which page is being written right now, folded from the call's own
      // arguments so it survives a replay like everything else here.
      if (toolName === 'generate_scene') {
        const order = (data.args as { order?: unknown } | undefined)?.order;
        if (typeof order === 'number') next.generatingOrder = order;
      }
      // Keep append-only write history for the workspace's pane-ownership gate.
      // Canvas freshness no longer reads this field (#1960 Part 2); manifest
      // revisions drive that path. `sighted` is where the reader-tool exclusion
      // lives, so a `read_stage` cannot enter here either.
      for (const stageId of sighted) {
        if (!next.touchedStageIds.includes(stageId)) {
          next.touchedStageIds = [...next.touchedStageIds, stageId];
        }
      }
      // A skill-load card can already exist for this call: the fold drew it from
      // the assistant frame's toolCall, which pi emits BEFORE it starts executing.
      // Upsert by call id rather than append, or a model-issued skill read paints
      // two rows for one read. Every other tool has no earlier signal, so this is
      // an append exactly as before.
      const callId = String(data.toolCallId ?? '');
      const existingIndex = callId
        ? next.chat.findIndex((node) => node.kind === 'tool' && node.toolCallId === callId)
        : -1;
      if (existingIndex >= 0) {
        next.chat = next.chat.map((node, index) =>
          index === existingIndex
            ? { ...node, toolName, toolArgs: toolArgsOf(data.args) ?? node.toolArgs }
            : node,
        );
        break;
      }
      next.chat = [
        ...next.chat,
        {
          key,
          kind: 'tool',
          text: '',
          toolCallId: callId,
          toolName,
          toolArgs: toolArgsOf(data.args),
          toolState: 'running',
          toolStartedAt: event.ts,
        },
      ];
      break;
    }
    case 'tool_execution_end': {
      const id = String(data.toolCallId ?? '');
      const ended = state.chat.find((n) => n.kind === 'tool' && n.toolCallId === id);
      if (ended?.toolName === 'generate_scene') next.generatingOrder = null;
      const result = data.result as { details?: unknown } | undefined;
      next.chat = state.chat.map((node) =>
        node.kind === 'tool' && node.toolCallId === id
          ? {
              ...node,
              toolState: data.isError ? 'failed' : 'done',
              toolDetails: result?.details,
              ...resultText(data.result),
              toolEndedAt: event.ts,
              // The trace ring SURVIVES completion: it leaves the collapsed row
              // (the micro-window only renders while running) and stays
              // available behind the disclosure.
            }
          : node,
      );
      next.waitingArmed = false;
      break;
    }
    case 'checkpoint': {
      // The stageId is a durable write receipt. Retain it as append-only
      // pane-ownership metadata, not as a canvas freshness trigger; DB
      // revisions + manifest sync own freshness now (#1960 Part 2). The card
      // for it is not painted here — it joins this exchange's set and lands at
      // `agent_end` (see `runCourseStageIds`).
      for (const stageId of sighted) {
        if (!next.touchedStageIds.includes(stageId)) {
          next.touchedStageIds = [...next.touchedStageIds, stageId];
        }
      }
      if (Array.isArray(data.outline)) {
        next.plan = data.outline as PlannedPage[];
        next.courseTitle = (data.courseTitle as string) ?? state.courseTitle;
        next.skillId = (data.skill as string) ?? state.skillId;
        next.skillViolations = (data.skillViolations as string[]) ?? [];
      }
      if (typeof data.order === 'number') {
        next.pages = {
          ...state.pages,
          [data.order]: {
            order: data.order,
            title: data.title as string | undefined,
            sceneId: data.sceneId as string | undefined,
            sceneType: data.sceneType as string | undefined,
            excerpt: data.excerpt as string | undefined,
            elementCount: data.elementCount as number | undefined,
          },
        };
        // THE trigger for the whole layout. A page has landed in the database,
        // so there is now a classroom worth showing, and the panel comes out.
        // Folded here rather than in a component effect so that a reload
        // replays into the same state: the log alone decides whether the panel
        // is out, exactly as it decides everything else.
        if (!next.panelPinned) next.panelOpen = true;
        /* THE LEGACY UNBOUND ROW, and only that. A v1 transcript's page
           checkpoint carried no stageId at all, so there is no id to put in an
           exchange's card set — and a log old enough to lack `stageId` may
           predate the pi frames the per-exchange rule flushes on, which would
           leave such a session with no course card at all. So this one row keeps
           its original behaviour verbatim: appended right here, at most one per
           session, and the renderer falls back to the session's own stage.
           Everything WITH a stageId goes through `agent_end` instead. */
        const legacyRowExists = next.chat.some(
          (n) => n.kind === 'course' && (n.stageIds?.length ?? 0) === 0,
        );
        if (sighted.length === 0 && !legacyRowExists) {
          next.chat = [...next.chat, { key: COURSE_NODE_KEY, kind: 'course', text: '' }];
        }
        // Attribute the committed page to the tool card that produced it, so
        // the chat's tool cards carry a real page reference.
        const sceneId = data.sceneId as string | undefined;
        if (sceneId) {
          const lastRunningIdx = [...next.chat]
            .reverse()
            .findIndex((n) => n.kind === 'tool' && n.toolState === 'running');
          if (lastRunningIdx >= 0) {
            const idx = next.chat.length - 1 - lastRunningIdx;
            next.chat = next.chat.map((n, i) => (i === idx ? { ...n, sceneId } : n));
          }
        }
      }
      break;
    }
    case 'agent_end': {
      /**
       * The ANSWER is over, so its classrooms are now a RESULT — one row at the
       * tail of the exchange that produced them, the way an artifact card sits at
       * the end of the reply that made it.
       *
       * `agent_end`, NOT `turn_end`. pi's `turn` is one assistant message plus
       * its tool calls, so "write me ten pages" is ten turns against ONE
       * classroom: flushing per turn ended that answer with ten identical cards.
       * One question, one answer, one card set.
       *
       * Keyed on this event, which makes the row's identity and its position
       * both deterministic from the log: a cold replay flushes at the same frame
       * with the same buffer and rebuilds the identical row. Draining the buffer
       * here is also what makes the rule per-exchange rather than per-session —
       * the next answer starts from empty, so asking about the same course again
       * earns another card.
       */
      if (next.runCourseStageIds.length > 0) {
        next.chat = [
          ...next.chat,
          { key, kind: 'course', text: '', stageIds: next.runCourseStageIds },
        ];
        next.runCourseStageIds = [];
      }
      // The answer is over, so there is no gap to indicate. Content arriving
      // normally closes the indicator before this, and `session_end` closes it
      // after — but an exchange that produced only tool calls and then ended
      // reaches neither, and left the thinking indicator on screen until the run settled.
      // (These two lines lived in a SECOND `case 'agent_end'` further down the
      // same switch, which a switch can never reach.)
      closeWaiting(next);
      next.waitingArmed = false;
      break;
    }
    case 'library_changed': {
      // A stage or folder write landed. The workspace's tree cannot know from
      // here WHAT it should look like — only that what it is showing predates a
      // write — so the fold counts the write and the shell refetches the
      // authoritative list (`useGeneratedCourseDiscoverySync`). Nothing else in
      // the chat reacts: a library write is not a conversation event, and a
      // system line announcing a created folder is the agent's own sentence to write.
      next.libraryRevision = state.libraryRevision + 1;
      // v1 transcripts recorded a minted stage ONLY here (`change:
      // 'stage_created'` — there was no `stage_link` yet), and the created-tab
      // fold that consumed it was removed in the rename. Bridge it into the
      // same first-seen `stageLinkStageIds` fold so a cold replay of a v1
      // multi-stage session still opens its tabs (cr#6 R6-P2-5). Current logs
      // that carry both events dedupe here naturally. `sighted` is empty for
      // every other `change`, so the guard is the shared one.
      for (const stageId of sighted) {
        if (!next.stageLinkStageIds.includes(stageId)) {
          next.stageLinkStageIds = [...next.stageLinkStageIds, stageId];
        }
      }
      break;
    }
    case 'active_stage_changed': {
      // v1-only lifecycle event: `switch_stage` moved the session's
      // active-stage pointer, and everything keyed on `WorkbenchState.stageId`
      // (course card link, pane auto-open, ownership's session-stage arm)
      // followed. The tool and its emitter are gone in the open-domain model,
      // but historical transcripts still carry the frames — replay them with
      // their original semantics so a v1 session's pane points at the course
      // it actually ended on (cr#6 R6-P2-5). The guard keeps a malformed
      // frame from erasing a known stage.
      if (typeof data.stageId === 'string' && data.stageId) next.stageId = data.stageId;
      break;
    }
    case 'course_link': // legacy event name (pre-rename logs) — same semantics
    case 'stage_link': {
      for (const stageId of sighted) {
        if (!next.stageLinkStageIds.includes(stageId)) {
          next.stageLinkStageIds = [...next.stageLinkStageIds, stageId];
        }
      }
      break;
    }
    case 'session_end': {
      const status = (data.status as SessionStatus) ?? 'succeeded';
      next.status = status;
      // A run ending is not a conversation ending. Success leaves no mark:
      // the next user bubble is the break. Cancel is a small centered note.
      // Failure stays loud so it cannot be scrolled past.
      closeWaiting(next);
      next.waitingArmed = false;
      next.generationOpen = false;
      next.thinkingKey = null;
      next.assistantKey = null;
      const settled = settleStreamingThinking(next.chat, event.ts).map((n) =>
        n.kind === 'assistant' && n.streaming ? { ...n, streaming: false } : n,
      );
      if (status === 'failed') {
        // Three fields, not one sentence: what happened, what to do, and the
        // raw cause (behind the notice's disclosure). The provider's own
        // English error text used to be spliced into the middle of the
        // sentence, which read as a log line and — because every auto-retry
        // appends its own marker — stacked N identical copies of it.
        const cause = data.error ? String(data.error).trim() : '';
        next.chat = [
          ...settled,
          {
            key,
            kind: 'system',
            tone: 'error',
            text: defaultWorkbenchTranslator('workbench.system.runFailed'),
            copyKey: 'workbench.system.runFailed',
            hint: defaultWorkbenchTranslator('workbench.system.retryHint'),
            hintCopyKey: 'workbench.system.retryHint',
            ...(cause ? { detail: cause } : {}),
          },
        ];
        break;
      }
      if (status === 'cancelled') {
        // Display backstop for the stop button. The runner aborts its in-flight
        // tool calls, so a well-behaved tool reports its own error and its card
        // settles through `tool_execution_end` like any other. Anything that
        // did NOT catch the signal — a tool that ignores abort, a call that
        // raced the loop's exit — would otherwise be left spinning under a
        // transcript that already says the run stopped. A stopped run has
        // nothing still running, so the cards say so.
        //
        // A run that was interrupted and then repaired can end cancelled
        // without ever reaching `agent_end` — a server restart parked it
        // (`session_interrupted`) and the next instance resumed it
        // (`session_resumed`) only for the stop to land before pi closed the
        // answer. The exchange's pending classroom sightings would otherwise
        // strand in the buffer and the timeline would end on the caption alone,
        // losing the course the answer produced. Flush them into the same card
        // set `agent_end` paints, so the terminal card carries the known stage
        // refs whenever the session has them.
        const pendingCourses =
          next.runCourseStageIds.length > 0
            ? [
                {
                  key: `${key}-course`,
                  kind: 'course' as const,
                  text: '',
                  stageIds: next.runCourseStageIds,
                },
              ]
            : [];
        if (pendingCourses.length > 0) next.runCourseStageIds = [];
        next.chat = [
          ...settleRunningToolCards(settled, {
            ts: event.ts,
            reason: defaultWorkbenchTranslator('workbench.system.userStopped'),
            reasonCopyKey: 'workbench.system.userStopped',
            onGeneratingCardSettled: () => {
              next.generatingOrder = null;
            },
          }),
          ...pendingCourses,
          {
            key,
            kind: 'boundary',
            text: defaultWorkbenchTranslator('workbench.system.stopped'),
            copyKey: 'workbench.system.stopped',
          },
        ];
        break;
      }
      next.chat = settled;
      break;
    }
    default:
      break;
  }

  const runError = runErrorOf(data);
  if (runError) {
    next.status = 'failed';
    next.error = runError;
    closeWaiting(next);
    next.waitingArmed = false;
    next.generationOpen = false;
    next.thinkingKey = null;
    next.assistantKey = null;
    next.chat = settleStreamingThinking(next.chat, event.ts).map((node) =>
      node.kind === 'assistant' && node.streaming ? { ...node, streaming: false } : node,
    );
  }
  return next;
}

export function foldEvents(state: WorkbenchFold, events: readonly WorkbenchEvent[]): WorkbenchFold {
  return events.reduce(foldEvent, state);
}

const REPLAY_STREAMING = new Set(['message_update', 'trace']);

/**
 * Drop token-by-token stream frames from a replay backlog — but keep the
 * FIRST and the LAST `message_update` of each run: the last carries the full
 * text, the first carries the stream's start timestamp (the thinking bar's
 * `startedAt`). Dropping the middle is what makes replay converge with the
 * live stream instead of redrawing shorter durations after a refresh. Traces
 * keep only the ring the live card would have shown. Live frames after
 * `caught_up` are not compacted.
 */
export function compactReplayEvents(events: readonly WorkbenchEvent[]): WorkbenchEvent[] {
  const out: WorkbenchEvent[] = [];
  let run: WorkbenchEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const type = run[0]?.type;
    if (type === 'message_update') {
      const first = run[0];
      const last = run[run.length - 1];
      if (first) out.push(first);
      if (last && last.id !== first?.id) out.push(last);
    } else if (type === 'trace') {
      out.push(...run.slice(-TRACE_RING_MAX));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const event of events) {
    if (run.length > 0 && run[0]?.type !== event.type) flush();
    if (REPLAY_STREAMING.has(event.type)) run.push(event);
    else {
      flush();
      out.push(event);
    }
  }
  flush();
  return out;
}

/** Compact one replay frame into the backlog in place so streaming stays O(1). */
export function appendCompactedReplayEvent(events: WorkbenchEvent[], event: WorkbenchEvent): void {
  const last = events[events.length - 1];
  if (event.type === 'message_update' && last?.type === 'message_update') {
    // Keep the FIRST and the LAST of the run (mirrors `compactReplayEvents`).
    // A run is stored as either [only] or [first, last]: if the slot before
    // the tail is also an update, the tail is the rolling `last` — overwrite
    // it; otherwise the run has one element so far, so the incoming frame
    // becomes the new `last` beside the preserved `first`.
    if (events[events.length - 2]?.type === 'message_update') {
      events[events.length - 1] = event;
    } else {
      events.push(event);
    }
    return;
  }
  if (event.type === 'trace' && last?.type === 'trace') {
    let start = events.length - 1;
    while (start >= 0 && events[start]?.type === 'trace') start -= 1;
    if (events.length - 1 - start >= TRACE_RING_MAX) events.splice(start + 1, 1);
    events.push(event);
    return;
  }
  events.push(event);
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  ...createInitialSessionState(),

  attach: (sessionId, stageId) =>
    set((state) =>
      // Re-attaching to the SAME session keeps the fold (that is the whole
      // point of unmounting the chat and coming back). A different session
      // starts clean.
      //
      // A null `stageId` on a re-attach is "I do not know it", never "it has
      // none": the deep-link path attaches without one and the meta fetch
      // fills it, so a later re-attach must not erase what was learned.
      state.sessionId === sessionId
        ? { sessionId, stageId: stageId ?? state.stageId }
        : {
            ...createInitialSessionState(),
            sessionId,
            // The two facts attaching adds to a never-ran state, and the only
            // two: a run we have not heard from yet is presumed LIVE (so the
            // composer offers STOP rather than flashing SEND first), and its
            // backlog is about to be replayed.
            status: 'connecting',
            replaying: true,
            ...readPanelPreference(sessionId),
            // `stageId` AFTER the initial state on purpose: that carries the
            // fold's `stageId: null`, and the caller's stage is the fact here.
            stageId,
          },
    ),

  /**
   * Hold no session — and therefore no run.
   *
   * ONE assignment, the whole state, because there is exactly one such state:
   * "detached" and "a draft conversation that does not exist yet" are the same
   * thing (the shell calls this the moment `?session=` leaves the URL, which is
   * what a new-chat press does), and every field of a finished-or-still-running previous
   * session has to be gone. A partial reset here is the bug that arrived three
   * times — see `createInitialSessionState`.
   */
  detach: () => set(createInitialSessionState()),
  setPanelOpen: (open, byUser = false) =>
    set((state) => {
      if (byUser && state.sessionId) writePanelPreference(state.sessionId, open);
      return { panelOpen: open, panelPinned: byUser ? true : state.panelPinned };
    }),
  setPlaybackOn: (on) => set({ playbackOn: on }),
  setAttached: (attached) => set({ attached }),
  setReplaying: (replaying) => set({ replaying }),
  finishReplay: () =>
    set((state) => ({
      replaying: false,
      replayedStageLinkCount: state.stageLinkStageIds.length,
    })),
  setError: (error) => set({ error }),
  setSessionPrompt: (sessionPrompt) => set({ sessionPrompt }),
  setSessionTitle: (sessionTitle) =>
    set((state) => ({
      sessionTitle,
      sessionTitleRevision: state.sessionTitleRevision + 1,
    })),
  setSessionBootstrap: (input) =>
    set((state) => ({
      ...(input.prompt !== undefined ? { sessionPrompt: input.prompt } : {}),
      ...(input.title !== undefined &&
      (input.expectedTitleRevision === undefined ||
        input.expectedTitleRevision === state.sessionTitleRevision)
        ? { sessionTitle: input.title }
        : {}),
      ...(input.status && state.lastEventId === 0 ? { status: input.status } : {}),
      // Only ever FILLS the stage, never overwrites: the attach path knows it
      // first-hand when it has it, and a late meta response for a session the
      // user has already switched away from must not repoint the course sync.
      ...(input.stageId && !state.stageId ? { stageId: input.stageId } : {}),
    })),

  applyEvent: (event) => set((state) => foldEvent(state, event)),
  applyEvents: (events) => {
    if (events.length === 0) return;
    set((state) => foldEvents(state, events));
  },
}));

// ── Control-plane client ─────────────────────────────────────────────────────

/** The session meta the PR1 control plane returns on create. */
export interface WorkbenchSessionMeta {
  id: string;
  stageId: string;
  status: SessionStatus;
  prompt: string;
  /** False when the server dropped the `@`-named classrooms it was sent. */
  courseRefsAccepted?: boolean;
}

/** A control-plane failure that keeps the HTTP status / error code. */
export class WorkbenchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly terminalStatus?: SessionStatus,
  ) {
    super(message);
    this.name = 'WorkbenchApiError';
  }
}

export async function createWorkbenchSession(input: {
  prompt: string;
  skill?: string;
  materials?: WorkbenchMaterial[];
  /**
   * Classrooms `@`-named on this first message. Only the launch composers use
   * this: every later mention rides its own `POST /messages`. Omitted from the
   * body entirely when empty, so a request without one is byte-identical to
   * what it always was.
   */
  courseRefs?: readonly CourseRef[];
  stageId?: string;
  existingCourse?: boolean;
}): Promise<WorkbenchSessionMeta> {
  const res = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.courseRefs?.length ? { courseRefs: input.courseRefs } : {}),
      ...(input.stageId ? { stageId: input.stageId } : {}),
      ...(input.existingCourse ? { existingCourse: true } : {}),
      ...(input.materials?.length
        ? { materialIds: input.materials.map((material) => material.materialId) }
        : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    stageId?: string;
    status?: SessionStatus;
    prompt?: string;
    courseRefs?: CourseRef[];
    error?: string;
    errorCode?: string;
    message?: string;
  };
  if (!res.ok || !body.id || !body.stageId) {
    throw new WorkbenchApiError(
      body.message ?? body.error ?? `POST /api/agent/sessions -> ${res.status}`,
      res.status,
      body.errorCode,
    );
  }
  return {
    id: body.id,
    stageId: body.stageId,
    status: body.status ?? 'queued',
    prompt: body.prompt ?? input.prompt,
    // The capability receipt, same idea as `POST /messages`': an older route
    // answers 202 while silently dropping a field it does not know. The caller
    // compares what came back with what it sent and says so rather than losing
    // a mention quietly.
    courseRefsAccepted: (body.courseRefs?.length ?? 0) >= (input.courseRefs?.length ?? 0),
  };
}

/**
 * Name a conversation, or clear the name (`null`) so its title goes back to
 * being derived from the first message.
 *
 * Returns the stored title — normally what was sent, but the server caps the
 * length, so the caller settles its optimistic write on the answer rather than
 * on its own input.
 */
export async function renameWorkbenchSession(
  sessionId: string,
  title: string | null,
): Promise<string | null> {
  const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    title?: string | null;
    error?: string;
    errorCode?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new WorkbenchApiError(
      body.message ?? body.error ?? `PATCH /api/agent/sessions -> ${res.status}`,
      res.status,
      body.errorCode,
    );
  }
  return body.title ?? null;
}

export async function cancelWorkbenchSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      code?: string;
      errorCode?: string;
      status?: SessionStatus;
    };
    throw new WorkbenchApiError(
      body.message ?? body.error ?? `POST cancel -> ${res.status}`,
      res.status,
      body.code ?? body.errorCode,
      body.status,
    );
  }
}

/** Recover the terminal status reported by cancel's already-finished conflict. */
export function terminalStatusFromCancelError(error: unknown): SessionStatus | null {
  if (!(error instanceof WorkbenchApiError) || error.status !== 409) return null;
  if (error.errorCode) {
    if (error.errorCode !== 'SESSION_ALREADY_TERMINAL') return null;
    return error.terminalStatus === 'succeeded' ||
      error.terminalStatus === 'failed' ||
      error.terminalStatus === 'cancelled'
      ? error.terminalStatus
      : null;
  }
  // Rolling-deploy compatibility with an older route that returned only text.
  const match = /^session is already (succeeded|failed|cancelled)$/.exec(error.message);
  return (match?.[1] as SessionStatus | undefined) ?? null;
}

/** Handle a terminal cancel conflict; mutate only if its session is still attached. */
export function recoverTerminalCancelStatus(sessionId: string, error: unknown): boolean {
  const status = terminalStatusFromCancelError(error);
  if (!status) return false;
  if (useWorkbenchStore.getState().sessionId !== sessionId) return true;
  useWorkbenchStore.setState({ status });
  return true;
}

/**
 * Send a follow-up into a live conversation. The server decides the delivery
 * shape (steer into a live run, or queue a new run on an idle session); the
 * event stream carries the bubble and whatever the agent does next, so there
 * is nothing to set locally here.
 *
 * `elementRefs` is omitted from the body entirely when nothing is staged. When
 * present, the control plane validates the complete element identity, persists
 * the refs on the durable user event, and the runner resolves them against the
 * active course before adding them to model context. `courseRefs` — the courses
 * the user named with `@` — follows exactly the same rule, and is likewise
 * absent from the body when the composer has none.
 */
export async function postWorkbenchMessage(
  sessionId: string,
  text: string,
  materials: WorkbenchMaterial[] = [],
  elementRefs: readonly ElementRef[] = [],
  courseRefs: readonly CourseRef[] = [],
): Promise<{ elementRefsAccepted: boolean; courseRefsAccepted: boolean }> {
  const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      ...(materials.length
        ? { materialIds: materials.map((material) => material.materialId) }
        : {}),
      ...(elementRefs.length ? { elementRefs } : {}),
      ...(courseRefs.length ? { courseRefs } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `POST messages -> ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    elementRefsAccepted?: unknown;
    courseRefsAccepted?: unknown;
  };
  return {
    elementRefsAccepted: body.elementRefsAccepted === true,
    courseRefsAccepted: body.courseRefsAccepted === true,
  };
}

/** A durable material asset selected in a workbench composer. */
export interface WorkbenchMaterial {
  materialId: string;
  name: string;
  bytes: number;
  mimeType?: string;
  extractionStatus?: 'idle' | 'pending' | 'running' | 'done' | 'failed';
}

export class WorkbenchMaterialUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'WorkbenchMaterialUploadError';
  }
}

/** Upload one file into the caller's durable material library. */
export async function uploadWorkbenchMaterial(file: File): Promise<WorkbenchMaterial> {
  const res = await fetch('/api/materials', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-material-filename': encodeURIComponent(file.name),
    },
    body: file,
    // Required by undici for streaming bodies; harmless otherwise.
    duplex: 'half',
  } as RequestInit);
  const body = (await res.json().catch(() => ({}))) as {
    materialId?: string;
    originalName?: string;
    bytes?: number;
    mime?: string;
    extraction?: { status?: WorkbenchMaterial['extractionStatus'] };
    error?: string;
    message?: string;
  };
  if (!res.ok || !body.materialId) {
    const requestId = res.headers.get('x-request-id') ?? undefined;
    const message = body.message ?? body.error ?? `POST /api/materials -> ${res.status}`;
    throw new WorkbenchMaterialUploadError(
      requestId ? `${message} [requestId=${requestId}]` : message,
      res.status,
      requestId,
    );
  }
  return {
    materialId: body.materialId,
    name: body.originalName ?? file.name,
    bytes: body.bytes ?? file.size,
    ...(body.mime || file.type ? { mimeType: body.mime || file.type } : {}),
    ...(body.extraction?.status ? { extractionStatus: body.extraction.status } : {}),
  };
}
