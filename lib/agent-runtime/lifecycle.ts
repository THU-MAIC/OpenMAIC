/**
 * Host lifecycle event names, importable from
 * both sides of the wire.
 *
 * This lives outside `lib/server/` and imports nothing on purpose. These names
 * are needed by the server (which emits them into the durable log) AND by the
 * browser (which must subscribe to each NAMED SSE frame by name: an
 * `EventSource` delivers `event: user_question` only to a listener registered
 * for that exact type, never to `onmessage`). The storage package also exports advisory lifecycle names. This host set remains
 * separate because it adds presentation-level events and is the browser-safe
 * subscription source; importing it must never pull a database dependency into
 * the client bundle.
 */
export interface StageLinkLifecycleData {
  stageId: string;
  title: string;
  url: string;
}

export const HOST_AGENT_LIFECYCLE = {
  sessionStart: 'session_start',
  sessionResumed: 'session_resumed',
  checkpoint: 'checkpoint',
  sessionEnd: 'session_end',
  /**
   * The run stopped WITHOUT a terminal status: the runner is shutting down
   * (deploy) or lost the lease. Not terminal — the session row stays
   * `running`, and the instance that steals it appends `session_resumed`.
   */
  sessionInterrupted: 'session_interrupted',
  /**
   * A message from the user, written by the CONTROL PLANE the moment it is
   * received — before any run or steer acts on it, so a crash loses nothing.
   * `data.delivery` is 'steer' (session was running; the worker injects it
   * mid-run) or 'queued' (session was idle; it drives the next run).
   */
  userMessage: 'user_message',
  /** Sub-step progress inside one long tool call (per-LLM-round-trip). */
  trace: 'trace',
  /**
   * The run's reasoning handed over to visible text: the first update of the
   * current message that carries text after carrying thinking. The chat fold
   * settles the streaming thinking bar on THIS durable frame, so the bar's
   * clock stops at the same instant live and on replay — token deltas are
   * volatile (compacted away on replay), a part's completion must not be.
   */
  thinkingEnd: 'thinking_end',
  /** Quiet progress/completion marker for a material attached to this session. */
  materialExtraction: 'material_extraction',
  /**
   * The agent asked the user a question and the run ended on it (ask_user is
   * terminal for the current run). `data` is the COMPLETE question envelope
   * the ask_user tool validated and echoed in its result:
   *
   *   {
   *     question: string,
   *     options?: { id: string; label: string }[],
   *     multiSelect?: boolean
   *   }
   *
   * The user answers through a nonblank ordinary message (postUserMessage),
   * which requeues the session for a new run; a textless material attachment
   * stays queued behind the question. There is deliberately NO
   * answer-correlation id — the question is a UI affordance (a question card,
   * `components/workbench/chat/question-card.tsx`, plus the pinned panel above
   * the composer), and the answer is simply the next nonblank user message,
   * which is also what retires it. An old frontend that does not know this
   * type ignores it (the chat fold's default case) and loses nothing but the
   * affordance.
   */
  userQuestion: 'user_question',
  /**
   * A tool produced or returned a stage link. `data` is
   * `{ stageId, title, url }`. The workbench opens each stageId only on its
   * first appearance in that session; later events for the same stage are
   * intentionally inert so a user's manual navigation is never overridden.
   *
   * DURABLE COMPAT: the pre-rename event name `course_link` is already written
   * into historical session logs. Emitters only ever write `stage_link`, but
   * the browser must keep accepting BOTH names on replay — the fold's reducer
   * matches both with identical semantics, and `WORKBENCH_EVENT_TYPES` keeps
   * subscribing to the old name (see `use-workbench-session.ts`).
   */
  stageLink: 'stage_link',
  /**
   * The owner's course LIBRARY changed shape — a course or folder was created,
   * a course was filed somewhere else, or a course was renamed. `data` is
   * `{ change: 'stage_created' | 'folder_created' | 'stage_moved' | 'stage_renamed', ... }`,
   * and
   * the payload's detail is diagnostic only: the workbench folds this into a
   * counter (`WorkbenchFold.libraryRevision`) and the workspace answers by
   * refetching the authoritative list, exactly as it already answers the first
   * committed page (`course-discovery-sync.ts`). Deliberately ONE event
   * for all four: the consumer's question is never "what changed" but "is my
   * tree stale", and the server is not the right place to diff a tree the client
   * is about to refetch anyway.
   *
   * This is what makes `create_stage` / `create_folder` / `move_to_folder` /
   * `rename_stage` show
   * up in the left rail without a reload. Page checkpoints do NOT emit it — a
   * page landing inside a course the tree already lists is not a library change,
   * and the existing first-page trigger already covers the one case where it is.
   */
  libraryChanged: 'library_changed',
} as const;

/** Every lifecycle event name the runner and control plane can write. */
export type HostAgentLifecycleEventType =
  (typeof HOST_AGENT_LIFECYCLE)[keyof typeof HOST_AGENT_LIFECYCLE];
