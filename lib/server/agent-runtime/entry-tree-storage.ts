import {
  Session,
  SessionError,
  type AgentMessage,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import {
  AGENT_SESSION_LIFECYCLE,
  AgentSessionEntryTreeError,
  AgentSessionLeaseLostError,
  type AgentSessionEntry,
  type AgentSessionEventLog,
  type AgentSessionEntryTreeHandle,
  type AgentSessionMeta,
} from '@openmaic/storage';

import { getAgentSessionStore } from './store';

export class SessionEntryHistoryError extends Error {
  override readonly name = 'SessionEntryHistoryError';

  constructor(
    readonly sessionId: string,
    reason: string,
  ) {
    super(`Session ${sessionId} has no usable complete entry tree: ${reason}`);
  }
}

export interface SessionEntryHistory {
  branch: SessionTreeEntry[];
  messages: AgentMessage[];
  /** Entry that materialized each buildContext message, in the same order. */
  contextEntryIds: string[];
  /** Raw append-only messages, unaffected by compaction, for delivery cursors. */
  cursorMessages: AgentMessage[];
  /**
   * For an empty tree that earlier runs left empty: the event sequence of the
   * first of those runs. A durable user message posted after it is a
   * follow-up, never the session's opening message.
   */
  firstRunSeq?: number;
}

/** What the event log says about the runs before this one. */
export interface PriorRunRecord {
  /** Event sequence of the first run's lifecycle frame; null when no run ever started. */
  firstRunSeq: number | null;
  /**
   * Whether a run completed a message. The runner appends every completed
   * message to the tree right after its event, so the tree must then hold it.
   */
  completedMessages: boolean;
}

/** Lifecycle frames that only a run (or its settlement) writes. */
const RUN_LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  AGENT_SESSION_LIFECYCLE.sessionStart,
  AGENT_SESSION_LIFECYCLE.sessionResumed,
  AGENT_SESSION_LIFECYCLE.sessionInterrupted,
  AGENT_SESSION_LIFECYCLE.sessionEnd,
]);
const PRIOR_RUN_SCAN_PAGE = 500;

/**
 * Read the prior runs from the event log, stopping at the first completed
 * message. Only consulted for an empty tree, whose log is short unless the
 * tree was lost, and then the scan stops at that run's first message.
 */
export async function readPriorRunRecord(
  log: Pick<AgentSessionEventLog, 'readEventsAfter'>,
  sessionId: string,
): Promise<PriorRunRecord> {
  let firstRunSeq: number | null = null;
  let after = 0;
  for (;;) {
    const page = await log.readEventsAfter(sessionId, after, PRIOR_RUN_SCAN_PAGE);
    for (const event of page) {
      if (event.type === 'message_end') return { firstRunSeq, completedMessages: true };
      if (firstRunSeq === null && RUN_LIFECYCLE_TYPES.has(event.type)) firstRunSeq = event.id;
    }
    if (page.length < PRIOR_RUN_SCAN_PAGE) return { firstRunSeq, completedMessages: false };
    after = page[page.length - 1]!.id;
  }
}

/**
 * Load and validate the one terminal entry-tree architecture understood by the
 * runner. An empty tree is legal before a session has ever started, and after
 * runs that ended before completing any message (a run that failed while
 * starting writes nothing). It is refused once the event log shows a completed
 * message the tree should hold: that tree lost history.
 */
export async function loadSessionEntryHistory(
  session: Session,
  options: { sessionId: string; priorRuns: () => Promise<PriorRunRecord> },
): Promise<SessionEntryHistory> {
  const entries = await session.getEntries();
  if (entries.length === 0) {
    const prior = await options.priorRuns();
    if (prior.completedMessages) {
      throw new SessionEntryHistoryError(
        options.sessionId,
        'tree is empty although a prior run completed messages',
      );
    }
    return {
      branch: [],
      messages: [],
      contextEntryIds: [],
      cursorMessages: [],
      ...(prior.firstRunSeq !== null ? { firstRunSeq: prior.firstRunSeq } : {}),
    };
  }

  let branch: SessionTreeEntry[];
  try {
    branch = await session.getBranch();
  } catch (error) {
    throw new SessionEntryHistoryError(
      options.sessionId,
      error instanceof Error ? error.message : String(error),
    );
  }
  const seen = new Set<string>();
  for (const entry of branch) {
    if (entry.type === 'compaction' && !seen.has(entry.firstKeptEntryId)) {
      throw new SessionEntryHistoryError(
        options.sessionId,
        `compaction ${entry.id} has a non-backward firstKeptEntryId ${entry.firstKeptEntryId}`,
      );
    }
    seen.add(entry.id);
  }

  const context = await session.buildContext();
  const latestCompactionIndex = branch.findLastIndex((entry) => entry.type === 'compaction');
  const contextEntries =
    latestCompactionIndex < 0
      ? branch.filter(
          (entry) =>
            entry.type === 'message' ||
            entry.type === 'custom_message' ||
            (entry.type === 'branch_summary' && Boolean(entry.summary)),
        )
      : [
          branch[latestCompactionIndex]!,
          ...branch.slice(0, latestCompactionIndex).filter((entry, index, all) => {
            const compaction = branch[latestCompactionIndex];
            if (!compaction || compaction.type !== 'compaction') return false;
            const firstKeptIndex = all.findIndex(
              (candidate) => candidate.id === compaction.firstKeptEntryId,
            );
            return (
              index >= firstKeptIndex &&
              (entry.type === 'message' ||
                entry.type === 'custom_message' ||
                (entry.type === 'branch_summary' && Boolean(entry.summary)))
            );
          }),
          ...branch
            .slice(latestCompactionIndex + 1)
            .filter(
              (entry) =>
                entry.type === 'message' ||
                entry.type === 'custom_message' ||
                (entry.type === 'branch_summary' && Boolean(entry.summary)),
            ),
        ];
  if (contextEntries.length !== context.messages.length) {
    throw new SessionEntryHistoryError(
      options.sessionId,
      'context-to-entry mapping is inconsistent',
    );
  }
  return {
    branch,
    messages: context.messages,
    contextEntryIds: contextEntries.map((entry) => entry.id),
    cursorMessages: branch.flatMap((entry) => (entry.type === 'message' ? [entry.message] : [])),
  };
}

export interface AgentSessionEntryStorageOpenOptions {
  sessionId: string;
  workerId: string;
  attempt: number;
}

function translateStorageError(error: unknown): never {
  if (error instanceof AgentSessionEntryTreeError) {
    // Keep the reference's distinction between a caller-referenced entry that
    // is merely absent (not_found) and a tree whose own structure is corrupt
    // (invalid_session): the package reports both as the same class, keyed by
    // the reason text.
    throw new SessionError(
      error.message.includes('missing entry') ? 'not_found' : 'invalid_session',
      error.message,
      error,
    );
  }
  if (error instanceof AgentSessionLeaseLostError) {
    throw new SessionError('storage', error.message, error);
  }
  // A session can vanish (for example, a concurrent soft-delete) between
  // open()'s existence pre-check and the package's own load; the package
  // reports that race as a plain error rather than a typed one, so classify
  // it the same way as the pre-check's not_found.
  if (error instanceof Error && error.message.includes('unknown session')) {
    throw new SessionError('not_found', error.message, error);
  }
  throw error;
}

async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return translateStorageError(error);
  }
}

/** Thin pi storage adapter over the package-owned append-only entry tree. */
export class AgentSessionEntryStorage implements SessionStorage<SessionMetadata> {
  private constructor(
    private readonly metadata: SessionMetadata,
    private readonly tree: AgentSessionEntryTreeHandle,
  ) {}

  static async open(
    options: AgentSessionEntryStorageOpenOptions,
  ): Promise<AgentSessionEntryStorage> {
    const store = await getAgentSessionStore();
    const session = await store.getSession(options.sessionId);
    if (!session) {
      throw new SessionError('not_found', `Session not found: ${options.sessionId}`);
    }
    const tree = await translated(() =>
      store.openEntryTree(options.sessionId, options.workerId, options.attempt),
    );
    return AgentSessionEntryStorage.fromHandle(session, tree);
  }

  /** Test and composition seam for an already-open package handle. */
  static fromHandle(
    session: Pick<AgentSessionMeta, 'id' | 'createdAt'>,
    tree: AgentSessionEntryTreeHandle,
  ): AgentSessionEntryStorage {
    return new AgentSessionEntryStorage(
      { id: session.id, createdAt: new Date(session.createdAt).toISOString() },
      tree,
    );
  }

  async getMetadata(): Promise<SessionMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    return translated(() => this.tree.getLeafId());
  }

  async setLeafId(leafId: string | null): Promise<void> {
    return translated(() => this.tree.setLeafId(leafId));
  }

  async createEntryId(): Promise<string> {
    return translated(() => this.tree.createEntryId());
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    return translated(() => this.tree.appendEntry(entry as AgentSessionEntry));
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return translated(async () => (await this.tree.getEntry(id)) as SessionTreeEntry | undefined);
  }

  async findEntries<TType extends SessionTreeEntry['type']>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return translated(
      async () =>
        (await this.tree.findEntries(type)) as Array<Extract<SessionTreeEntry, { type: TType }>>,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return translated(() => this.tree.getLabel(id));
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    return translated(async () => (await this.tree.getPathToRoot(leafId)) as SessionTreeEntry[]);
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return translated(async () => (await this.tree.getEntries()) as SessionTreeEntry[]);
  }
}
