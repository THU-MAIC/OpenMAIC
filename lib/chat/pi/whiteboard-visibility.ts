import { nanoid } from 'nanoid';

export type WhiteboardVisibility = 'open' | 'closed' | 'unknown';

type PendingVisibilityQuery = {
  queryId: string;
  stageId: string;
  learnerKey: string;
  resolve: (visibility: WhiteboardVisibility) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
};

type PendingVisibilityState = Map<string, PendingVisibilityQuery>;

const PENDING_VISIBILITY_KEY = Symbol.for('openmaic.pi.whiteboard-visibility.pending');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: PendingVisibilityState | undefined;
};
const pendingQueries = (globalState[PENDING_VISIBILITY_KEY] ??= new Map());

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(
        typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
        'AbortError',
      );
}

function settle(
  entry: PendingVisibilityQuery,
  outcome: { visibility: WhiteboardVisibility } | { error: unknown },
): void {
  if (entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
  if (pendingQueries.get(entry.queryId) === entry) {
    pendingQueries.delete(entry.queryId);
  }
  if ('error' in outcome) entry.reject(outcome.error);
  else entry.resolve(outcome.visibility);
}

function uniqueQueryId(): string {
  let queryId = nanoid();
  while (pendingQueries.has(queryId)) queryId = nanoid();
  return queryId;
}

export async function queryWhiteboardVisibility(opts: {
  stageId: string;
  learnerKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
  dispatch: (queryId: string) => Promise<void>;
}): Promise<WhiteboardVisibility> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);
  const queryId = uniqueQueryId();

  const result = new Promise<WhiteboardVisibility>((resolve, reject) => {
    const entry: PendingVisibilityQuery = {
      queryId,
      stageId: opts.stageId,
      learnerKey: opts.learnerKey,
      resolve,
      reject,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      signal: opts.signal,
      settled: false,
    };

    entry.timer = setTimeout(() => settle(entry, { visibility: 'unknown' }), opts.timeoutMs);
    if (opts.signal) {
      entry.onAbort = () => settle(entry, { error: abortReason(opts.signal!) });
      opts.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    pendingQueries.set(queryId, entry);

    void Promise.resolve()
      .then(() => opts.dispatch(queryId))
      .catch(() => {
        if (opts.signal?.aborted) settle(entry, { error: abortReason(opts.signal) });
        else settle(entry, { visibility: 'unknown' });
      });
  });

  return result;
}

export function settleWhiteboardVisibility(opts: {
  queryId: string;
  stageId: string;
  learnerKey: string;
  visibility: Exclude<WhiteboardVisibility, 'unknown'>;
}): boolean {
  const entry = pendingQueries.get(opts.queryId);
  if (
    !entry ||
    entry.stageId !== opts.stageId ||
    entry.learnerKey !== opts.learnerKey ||
    entry.settled
  ) {
    return false;
  }
  settle(entry, { visibility: opts.visibility });
  return true;
}
