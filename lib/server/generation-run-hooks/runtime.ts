/**
 * How generation calls the registered hooks: each helper is a no-op (or the
 * plain call) when its hook is not registered, and keeps a host's mistake
 * from corrupting a run.
 */
import { createLogger } from '@/lib/logger';

import { getGenerationRunHooks } from './registry';
import type {
  GenerationExecutionContext,
  GenerationFailureClassification,
  GenerationRunAttributes,
  GenerationRunHookEvent,
  GenerationStartContext,
  UnresolvedGenerationRunHookEvent,
} from './types';

const log = createLogger('GenerationRunHooks');

/** Attributes larger than this, as JSON, are refused (a fault of the host). */
export const MAX_RUN_ATTRIBUTES_BYTES = 8 * 1024;

/** A start the host's `authorizeStart` refused; the route answers with it. */
export class GenerationStartRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Headers,
  ) {
    super(message);
    this.name = 'GenerationStartRefusedError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validAttributes(value: unknown, hook: string): GenerationRunAttributes {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${hook} answered attributes that are not a { [key]: string } object`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_RUN_ATTRIBUTES_BYTES) {
    throw new Error(
      `${hook} answered ${bytes} bytes of attributes; at most ${MAX_RUN_ATTRIBUTES_BYTES} are kept`,
    );
  }
  return { ...(value as Record<string, string>) };
}

/**
 * Ask the host whether a start may create its run. Answers the attributes to
 * store with the run (`undefined` without the hook); throws
 * {@link GenerationStartRefusedError} for a refusal, and a plain error for an
 * answer that is neither (a fault: the start fails with a `500`).
 */
export async function authorizeGenerationStart(
  context: GenerationStartContext,
): Promise<GenerationRunAttributes | undefined> {
  const { authorizeStart, name } = getGenerationRunHooks();
  if (!authorizeStart) return undefined;
  const hook = `authorizeStart (${name})`;
  const decision: unknown = await authorizeStart(context);
  if (!isPlainObject(decision) || typeof decision.allow !== 'boolean') {
    throw new Error(`${hook} answered something other than { allow: boolean }`);
  }
  if (decision.allow) return validAttributes(decision.attributes, hook);
  const { status, code, message, headers } = decision;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(`${hook} refused with a status that is not 400-599`);
  }
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new Error(`${hook} refused with a code that is not upper-case letters, digits and _`);
  }
  if (typeof message !== 'string' || !message) {
    throw new Error(`${hook} refused without a message`);
  }
  throw new GenerationStartRefusedError(
    status,
    code,
    message,
    new Headers((headers as HeadersInit | undefined) ?? undefined),
  );
}

/** How {@link runGenerationExecution} ended. */
export type GenerationExecutionResult<T> =
  | { readonly ran: true; readonly value: T }
  /** The host's `wrapExecution` threw (or settled) without running the execution. */
  | { readonly ran: false; readonly error: unknown };

/**
 * Run one claimed execution inside the host's `wrapExecution`, or directly
 * without it. The execution's own outcome is authoritative: its value is
 * answered and its failure thrown whatever the wrapper does around it. A
 * wrapper that never ran it answers `{ ran: false }` for the caller to
 * refuse the execution with.
 */
export async function runGenerationExecution<T>(
  context: GenerationExecutionContext,
  execute: () => Promise<T>,
): Promise<GenerationExecutionResult<T>> {
  const { wrapExecution, name } = getGenerationRunHooks();
  if (!wrapExecution) return { ran: true, value: await execute() };
  let running: Promise<T> | undefined;
  let wrapperFailure: { error: unknown } | undefined;
  try {
    await wrapExecution(context, () => {
      if (running) {
        return Promise.reject(new Error(`wrapExecution (${name}) ran the execution twice`));
      }
      running = execute();
      return running;
    });
  } catch (error) {
    wrapperFailure = { error };
  }
  if (!running) {
    return {
      ran: false,
      error:
        wrapperFailure?.error ??
        new Error(`wrapExecution (${name}) settled without running the execution`),
    };
  }
  if (wrapperFailure) {
    const own = await running.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (own !== wrapperFailure.error) {
      log.warn(
        `wrapExecution (${name}) failed around an execution; its outcome stands`,
        wrapperFailure.error,
      );
    }
  }
  return { ran: true, value: await running };
}

function validClassification(value: unknown): value is GenerationFailureClassification {
  if (!isPlainObject(value)) return false;
  const { errorCode, retryable, statusCode } = value;
  return (
    typeof errorCode === 'string' &&
    errorCode.length > 0 &&
    typeof retryable === 'boolean' &&
    (statusCode === undefined || (typeof statusCode === 'number' && Number.isInteger(statusCode)))
  );
}

/** The errors a failure wraps (`cause`, an SDK's `lastError` and `errors`), outermost first. */
function wrapped(error: unknown): unknown[] {
  if (!error || typeof error !== 'object') return [];
  const record = error as { cause?: unknown; lastError?: unknown; errors?: unknown };
  return [
    ...('cause' in record ? [record.cause] : []),
    ...('lastError' in record ? [record.lastError] : []),
    ...(Array.isArray(record.errors) ? record.errors : []),
  ];
}

/**
 * The host's classification of a failure, or `undefined` when there is no
 * `classifyFailure` or it does not know the failure. The errors the failure
 * wraps are asked too, outermost first (a provider SDK wraps what a fetch
 * threw). A classifier that throws or answers malformed is logged and ignored.
 */
export function classifyHostFailure(error: unknown): GenerationFailureClassification | undefined {
  const { classifyFailure, name } = getGenerationRunHooks();
  if (!classifyFailure) return undefined;
  const seen = new Set<unknown>();
  let level: unknown[] = [error];
  for (let depth = 0; depth < 4 && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const candidate of level) {
      if (candidate === undefined || candidate === null || seen.has(candidate)) continue;
      seen.add(candidate);
      let answer: unknown;
      try {
        answer = classifyFailure(candidate);
      } catch (classifierError) {
        log.warn(
          `classifyFailure (${name}) threw; the failure is classified as built in`,
          classifierError,
        );
        return undefined;
      }
      if (answer !== undefined) {
        if (validClassification(answer)) return answer;
        log.warn(`classifyFailure (${name}) answered a malformed classification; ignored`);
        return undefined;
      }
      next.push(...wrapped(candidate));
    }
    level = next;
  }
  return undefined;
}

/** Whether the host says a failure is not worth an automatic retry. */
export function isNonRetryableHostFailure(error: unknown): boolean {
  return classifyHostFailure(error)?.retryable === false;
}

/**
 * How long one notification waits for its current owner before it is
 * reported with the stored owner instead.
 */
export const OWNER_LOOKUP_TIMEOUT_MS = 5_000;
/**
 * Notifications one process holds while earlier ones resolve their owner.
 * When the queue is full, a new notification is dropped (the ones already
 * queued keep their order), and the drop is counted in a warning.
 */
export const MAX_PENDING_RUN_EVENTS = 1_000;

interface NotificationQueue {
  tail: Promise<void>;
  pending: number;
  dropped: number;
  lookupTimeoutMs: number;
  maxPending: number;
}

function freshQueue(): NotificationQueue {
  return {
    tail: Promise.resolve(),
    pending: 0,
    dropped: 0,
    lookupTimeoutMs: OWNER_LOOKUP_TIMEOUT_MS,
    maxPending: MAX_PENDING_RUN_EVENTS,
  };
}

/** Notifications of this process, in the order their transitions committed. */
let queue = freshQueue();

/** A fresh queue with these limits (tests). */
export function resetRunEventQueueForTests(
  limits: Partial<Pick<NotificationQueue, 'lookupTimeoutMs' | 'maxPending'>> = {},
): void {
  queue = { ...freshQueue(), ...limits };
}

/** `lookup()`, or `fallback` once it fails or takes longer than `ms`. */
async function ownerWithin(
  lookup: () => Promise<string>,
  fallback: string,
  ms: number,
  runId: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`run ${runId}: its current owner took over ${ms} ms to resolve for onRunEvent`);
      resolve(fallback);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      lookup().catch((error: unknown) => {
        log.warn(`run ${runId}: its current owner could not be resolved for onRunEvent`, error);
        return fallback;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell the host about a committed transition, with the owner the run works
 * for now (`currentOwner()`, resolved only when a listener is registered; the
 * stored owner if it fails or exceeds {@link OWNER_LOOKUP_TIMEOUT_MS}). Never
 * throws and never waits: the listener is called after the notifications
 * queued before this one, and a notification that finds
 * {@link MAX_PENDING_RUN_EVENTS} queued is dropped.
 */
export function reportGenerationRunEvent(
  event: UnresolvedGenerationRunHookEvent,
  currentOwner: () => Promise<string>,
): void {
  const { onRunEvent, name } = getGenerationRunHooks();
  if (!onRunEvent) return;
  const failed = (error: unknown) =>
    log.warn(`onRunEvent (${name}) failed on ${event.type} of ${event.runId}; ignored`, error);
  const current = queue;
  if (current.pending >= current.maxPending) {
    current.dropped += 1;
    log.warn(
      `onRunEvent (${name}): ${current.pending} notifications are queued; dropped ` +
        `${event.type} of ${event.runId} (${current.dropped} dropped so far)`,
    );
    return;
  }
  current.pending += 1;
  current.tail = current.tail.then(async () => {
    const currentOwnerId = await ownerWithin(
      currentOwner,
      event.ownerId,
      current.lookupTimeoutMs,
      event.runId,
    );
    current.pending -= 1;
    try {
      const result = onRunEvent({ ...event, currentOwnerId } as GenerationRunHookEvent);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  });
}
