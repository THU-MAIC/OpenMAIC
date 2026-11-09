/**
 * Pure projections behind the Pro workspace sidebar. Everything here is data
 * shaping only — no fetching, no React — so the ordering and the relative-time
 * bucketing can be tested without a browser.
 */

export interface ProHomeSessionItem {
  readonly id: string;
  readonly stageId: string;
  readonly prompt: string;
  /**
   * The stored automatic or manual title, if any. It takes precedence over the
   * fallback derived from `prompt` — see `lib/workbench/session-title`.
   */
  readonly title?: string | null;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** Started beside an existing course (the session's durable flag); absent on older rows. */
  readonly existingCourse?: boolean;
  /**
   * The agent asked the user a question (`ask_user`) that nothing has answered
   * yet, and no run is in flight. Derived server-side from the event log (see
   * `@openmaic/storage`'s `AgentSessionMeta.awaitingAnswer`); absent means no.
   */
  readonly awaitingAnswer?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ProHomeSessionStatus = ProHomeSessionItem['status'];

function isLiveStatus(status: ProHomeSessionStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** A row with its status and awaiting flag replaced; `awaitingAnswer` is kept absent when false. */
function withStatus(
  item: ProHomeSessionItem,
  status: ProHomeSessionStatus,
  awaitingAnswer: boolean,
): ProHomeSessionItem {
  const { awaitingAnswer: _previous, ...rest } = item;
  return awaitingAnswer ? { ...rest, status, awaitingAnswer: true } : { ...rest, status };
}

/**
 * Overlay the attached conversation's live fold onto the owner-event list.
 *
 * The owner stream and the attached session stream are independent wires. A
 * lifecycle frame can therefore reach the attached fold before the matching
 * owner summary reaches the rail (or vice versa). Only the attached session is
 * safe to reconcile here: every other row may belong to another tab or worker
 * and remains owned by the owner stream plus periodic full reconciliation.
 *
 * Neither `connecting` nor `idle` is a durable session status: the first is a
 * client-only bootstrap state, the second is "the store holds no session at all".
 * Ignoring both prevents a session switch — or a new-chat press, which detaches —
 * from erasing a real queued or running indication before the meta/event replay
 * catches up.
 *
 * `awaitingAnswer` rides the same overlay: the fold's open question card is the
 * same fact the server derives, seen earlier, so answering in the attached chat
 * clears the row's mark at once instead of after the owner event. Leave it
 * undefined (e.g. while the backlog is still replaying) to keep the row's own
 * value. A live status never awaits an answer.
 */
export function reconcileAttachedSessionStatus(
  sessions: readonly ProHomeSessionItem[],
  attached: {
    readonly paneId: string | null;
    readonly attachedId: string | null;
    readonly status: ProHomeSessionStatus | 'connecting' | 'idle';
    readonly connected?: boolean;
    readonly pendingWork?: boolean;
    readonly awaitingAnswer?: boolean;
  },
): readonly ProHomeSessionItem[] {
  const {
    paneId,
    attachedId,
    status,
    connected = true,
    pendingWork = false,
    awaitingAnswer,
  } = attached;
  if (!connected || !paneId || attachedId !== paneId) return sessions;
  if (status === 'connecting' || status === 'idle') return sessions;
  const index = sessions.findIndex((session) => session.id === attachedId);
  if (index < 0) return sessions;
  const row = sessions[index]!;
  // A queued follow-up opens work in the fold before the next run emits
  // session_resumed. In that window the fresh live list row must win over the
  // previous terminal lifecycle event. Otherwise the attached event fold is
  // authoritative: unlike the row's generic updatedAt (also advanced by
  // heartbeats and transcript saves), pendingWork has the same lifecycle
  // meaning as the status being reconciled.
  const foldIsTerminal = !isLiveStatus(status);
  const keepRow = isLiveStatus(row.status) && foldIsTerminal && pendingWork;
  const nextStatus = keepRow ? row.status : status;
  const nextAwaiting = isLiveStatus(nextStatus)
    ? false
    : keepRow || awaitingAnswer === undefined
      ? row.awaitingAnswer === true
      : awaitingAnswer;
  if (row.status === nextStatus && (row.awaitingAnswer === true) === nextAwaiting) return sessions;
  return sessions.map((session, current) =>
    current === index ? withStatus(session, nextStatus, nextAwaiting) : session,
  );
}

interface OwnerSessionEventBase {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly phase: 'backlog' | 'live';
}

export type OwnerSessionEvent =
  | (OwnerSessionEventBase & {
      readonly type: 'session_created' | 'session_status';
      readonly status: ProHomeSessionStatus;
      readonly attempt: number;
      /** The server's verdict for the recorded status; absent means no. */
      readonly awaitingAnswer?: boolean;
    })
  | (OwnerSessionEventBase & {
      readonly type: 'session_deleted' | 'session_cancel_requested';
    })
  | (OwnerSessionEventBase & {
      readonly type: 'session_active_stage';
      readonly activeStageId: string;
    })
  | (OwnerSessionEventBase & {
      readonly type: 'session_title';
      readonly title: string | null;
    });

export interface OwnerSessionReduceResult {
  readonly sessions: readonly ProHomeSessionItem[];
  readonly needsFullFetch: boolean;
}

/**
 * Fold one sparse owner event into materialised rail rows.
 *
 * Sparse events can update an existing row but cannot create one: prompt,
 * stageId and creation timestamps intentionally never enter the owner event
 * log. Any event for an unknown id therefore asks the IO layer for a complete
 * snapshot. Owner-visible transitions, including title changes, use their
 * event timestamp as rail activity. Heartbeat-only updates affect order when
 * the next full snapshot reconciles the row's generic updatedAt.
 */
export function reduceOwnerSessionEvent(
  sessions: readonly ProHomeSessionItem[],
  event: OwnerSessionEvent,
): OwnerSessionReduceResult {
  const index = sessions.findIndex((session) => session.id === event.sessionId);
  if (index < 0) return { sessions, needsFullFetch: true };

  if (event.type === 'session_deleted') {
    return {
      sessions: sessions.filter((_, current) => current !== index),
      needsFullFetch: false,
    };
  }

  const current = sessions[index]!;
  // PostgreSQL timestamps lose sub-millisecond ordering when projected to JS.
  // An equal timestamp is ambiguous, so the client reconciles it with a read.
  if (event.type === 'session_title' && event.ts <= current.updatedAt) {
    return { sessions, needsFullFetch: false };
  }
  const changed: ProHomeSessionItem =
    event.type === 'session_status' || event.type === 'session_created'
      ? {
          ...withStatus(
            current,
            event.status,
            !isLiveStatus(event.status) && event.awaitingAnswer === true,
          ),
          updatedAt: event.ts,
        }
      : event.type === 'session_active_stage'
        ? { ...current, stageId: event.activeStageId, updatedAt: event.ts }
        : event.type === 'session_title'
          ? { ...current, title: event.title, updatedAt: event.ts }
          : { ...current, updatedAt: event.ts };
  const next = sessions.map((session, currentIndex) =>
    currentIndex === index ? changed : session,
  );
  return { sessions: newestFirst(next), needsFullFetch: false };
}

export interface OwnerStreamState {
  readonly initialized: boolean;
  readonly degraded: boolean;
}

export type OwnerStreamSignal =
  | { readonly type: 'caught_up'; readonly degraded?: boolean }
  | { readonly type: 'owner_moved' };

export interface OwnerStreamTransition {
  readonly state: OwnerStreamState;
  readonly needsFullFetch: boolean;
  readonly reconnect: boolean;
  readonly initializedNow: boolean;
}

/** Pure control-plane fold used by the EventSource owner. */
export function reduceOwnerStreamSignal(
  state: OwnerStreamState,
  signal: OwnerStreamSignal,
): OwnerStreamTransition {
  if (signal.type === 'owner_moved') {
    return {
      state: { initialized: state.initialized, degraded: false },
      needsFullFetch: true,
      reconnect: true,
      initializedNow: false,
    };
  }
  if (signal.degraded) {
    return {
      state: { ...state, degraded: true },
      needsFullFetch: true,
      reconnect: false,
      initializedNow: false,
    };
  }
  return {
    state: { initialized: true, degraded: false },
    needsFullFetch: false,
    reconnect: false,
    initializedNow: !state.initialized,
  };
}

export type SessionRowMarkKind = 'running' | 'queued' | 'awaiting' | 'failed';

/**
 * The one mark a rail chat row shows in place of its time, by precedence: a run
 * waiting its turn (queued, a still clock) or under way (a spinner) outranks a question waiting on the teacher, which outranks a
 * failure (a question asked after a failed attempt is the newer fact). `null`
 * is the row at rest, which shows its relative time.
 */
export function sessionRowMark(
  session: Pick<ProHomeSessionItem, 'status' | 'awaitingAnswer'>,
): SessionRowMarkKind | null {
  if (session.status === 'queued') return 'queued';
  if (isLiveStatus(session.status)) return 'running';
  if (session.awaitingAnswer) return 'awaiting';
  if (session.status === 'failed') return 'failed';
  return null;
}

/** Course ids whose attached sessions are still doing work. */
export function runningSessionStageIds(
  sessions: readonly ProHomeSessionItem[],
): ReadonlySet<string> {
  return new Set(
    sessions
      .filter((session) => session.status === 'running' || session.status === 'queued')
      .map((session) => session.stageId),
  );
}

export interface ProHomeCourseItem {
  readonly id: string;
  readonly name: string;
  readonly sceneCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function activityAt(item: { readonly updatedAt?: number; readonly createdAt?: number }): number {
  const updated = Number(item.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Number(item.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/** API lists are oldest-first; the workspace always projects a copied newest-first list. */
export function newestFirst<T extends { readonly updatedAt?: number; readonly createdAt?: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => activityAt(b) - activityAt(a));
}

/**
 * The sidebar's timestamp bucket. Returning a bucket rather than a string
 * keeps the copy in the locale files: the caller maps `unit` to a key and
 * interpolates `count`.
 *
 * `null` means "say nothing" — a missing or nonsensical timestamp gets no
 * metadata rather than a fabricated "just now".
 */
export type RelativeBucket =
  | { readonly unit: 'now' }
  | { readonly unit: 'minutes'; readonly count: number }
  | { readonly unit: 'hours'; readonly count: number }
  | { readonly unit: 'days'; readonly count: number }
  | { readonly unit: 'date'; readonly at: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeBucket(timestamp: number, now: number): RelativeBucket | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const elapsed = now - timestamp;
  // A clock skewed into the future reads as "now" rather than a negative age.
  if (elapsed < MINUTE) return { unit: 'now' };
  if (elapsed < HOUR) return { unit: 'minutes', count: Math.floor(elapsed / MINUTE) };
  if (elapsed < DAY) return { unit: 'hours', count: Math.floor(elapsed / HOUR) };
  if (elapsed < 7 * DAY) return { unit: 'days', count: Math.floor(elapsed / DAY) };
  return { unit: 'date', at: timestamp };
}
