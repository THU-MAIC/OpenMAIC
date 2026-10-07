/**
 * Host hooks for server-side generation work: course generation runs and the
 * background extraction of uploaded materials.
 *
 * Four points where a host adds behavior around generation without forking
 * the run engine, for example to meter usage, enforce a quota or keep an
 * audit trail:
 *
 * - {@link GenerationRunHooks.authorizeStart}: admit or refuse a run before it
 *   exists, and attach attributes to it.
 * - {@link GenerationRunHooks.wrapExecution}: run every claimed execution inside
 *   the host's own context (an `AsyncLocalStorage` scope, a tracing span).
 * - {@link GenerationRunHooks.classifyFailure}: say what a host error thrown
 *   inside that context means for the run.
 * - {@link GenerationRunHooks.onRunEvent}: be told, after the fact, how a run
 *   progressed.
 *
 * Registered once, at server bootstrap, from `instrumentation.ts`
 * `register()` (see `./registry.ts`). With nothing registered, generation
 * behaves exactly as it did before the hooks existed.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { GenerationRunInput } from '@/lib/server/generation/run/types';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

/**
 * String key/value pairs a host attaches to a run when it admits it. Stored
 * on the run row (never shown to the run's owner) and handed back to every
 * hook about that run, in every process that executes it.
 */
export type GenerationRunAttributes = Readonly<Record<string, string>>;

/** The route a run was started from. */
export type GenerationStartOrigin = 'generation-runs' | 'generate-classroom';

/** What {@link GenerationRunHooks.authorizeStart} is given. */
export interface GenerationStartContext {
  /** The id the run will have if the start is admitted. */
  readonly runId: string;
  /** The principal the request resolved to. */
  readonly principal: OwnerPrincipal;
  /** The owner the run is created under (`principal.ownerId`). */
  readonly ownerId: string;
  /** The validated run input. */
  readonly input: Readonly<GenerationRunInput>;
  /** The start request, for its headers. Its body was already read. */
  readonly request: Request;
  readonly origin: GenerationStartOrigin;
  /**
   * The transaction that creates the run. Statements on it commit or roll
   * back with the run; the owner's starts are serialized on it.
   */
  readonly tx: Queryable;
}

/** The answer of {@link GenerationRunHooks.authorizeStart}. */
export type GenerationStartDecision =
  | {
      readonly allow: true;
      /** Kept on the run (at most 8 KiB as JSON). */
      readonly attributes?: GenerationRunAttributes;
    }
  | {
      readonly allow: false;
      /** The HTTP status of the refusal, 400-599. */
      readonly status: number;
      /** The `errorCode` of the error body: upper-case letters, digits and `_`. */
      readonly code: string;
      /** The `error` of the error body, shown to the client. */
      readonly message: string;
      /** Added to the refusal (a `Retry-After`, say). */
      readonly headers?: HeadersInit;
    };

/**
 * One claimed execution, as {@link GenerationRunHooks.wrapExecution} is told
 * about it. Discriminated by `kind`.
 */
export type GenerationExecutionContext =
  | {
      readonly kind: 'generation-run';
      readonly runId: string;
      /** The owner the run was started by, as stored on the run. */
      readonly ownerId: string;
      /**
       * The owner the run works for now: `ownerId`, or the account it was
       * claimed into since. Usage belongs to this owner.
       */
      readonly currentOwnerId: string;
      /** The run's course, when it exists at the time of the claim. */
      readonly stageId?: string;
      /** What `authorizeStart` attached to the run; empty when nothing was. */
      readonly attributes: GenerationRunAttributes;
      /** The previous holder's lease went stale (a crash or a restart). */
      readonly takeover: boolean;
    }
  | {
      readonly kind: 'material-extraction';
      readonly materialId: string;
      /** The owner of the material (a claim moves materials with it). */
      readonly ownerId: string;
      readonly currentOwnerId: string;
    };

/** What {@link GenerationRunHooks.classifyFailure} answers for a host error. */
export interface GenerationFailureClassification {
  /** The stable code the failure is reported with (`step_failed`, the paused run's error). */
  readonly errorCode: string;
  /**
   * Whether an automatic retry is worthwhile. `false` skips the step's
   * remaining retries (the provider SDK's own retries included) and model
   * fallback, and pauses the run at the step;
   * the owner's Retry resumes it as for any other failure.
   */
  readonly retryable: boolean;
  /** An HTTP status to report with the failure. */
  readonly statusCode?: number;
}

interface GenerationRunEventBase {
  readonly runId: string;
  /** The owner the run was started by, as stored on the run. */
  readonly ownerId: string;
  /**
   * The owner the run works for when the event is reported: `ownerId`, or
   * the account it was claimed into since (resolved as for `wrapExecution`).
   * Attribute usage to this owner.
   */
  readonly currentOwnerId: string;
  readonly attributes: GenerationRunAttributes;
}

/** A notification before its current owner is resolved. */
export type UnresolvedGenerationRunHookEvent = GenerationRunHookEvent extends infer E
  ? E extends GenerationRunHookEvent
    ? Omit<E, 'currentOwnerId'>
    : never
  : never;

/** What {@link GenerationRunHooks.onRunEvent} is told. */
export type GenerationRunHookEvent = GenerationRunEventBase &
  (
    | { readonly type: 'started' }
    | { readonly type: 'outline-ready'; readonly scenesTotal: number }
    | {
        readonly type: 'scene-appended';
        readonly stageId: string;
        readonly sceneIndex: number;
        readonly sceneId: string;
        readonly scenesCompleted: number;
        readonly scenesTotal: number;
      }
    | { readonly type: 'paused'; readonly step: string | null; readonly errorCode?: string }
    | { readonly type: 'completed'; readonly stageId: string }
    | { readonly type: 'ended'; readonly stageId: string | null }
  );

/** The hooks {@link configureGenerationRunHooks} registers. Every hook is optional. */
export interface GenerationRunHooks {
  /** Short label for logs and boot errors. */
  readonly name: string;
  /**
   * May this start create a run? It runs while the owner's starts are
   * serialized on `tx`: keep it fast, and do no network I/O in it. Called once per start on
   * `POST /api/generation-runs` and `POST /api/generate-classroom`, after
   * every built-in check (the body, the required models, the materials and
   * agents, the owner's run limits), inside the transaction that creates the
   * run, before its row is written. A refusal answers the request with the
   * refusal's status, code and message, and no run is created; a throw is a
   * `500`.
   */
  readonly authorizeStart?: (context: GenerationStartContext) => Promise<GenerationStartDecision>;
  /**
   * Runs one claimed execution: of a run (every claim: the first, a
   * takeover after a lease went stale, the claim after a Retry or an outline
   * confirmation, one for a paused or completed run's media) or of a
   * material's background extraction. Must call `execute` once and answer
   * what it answers. A throw before `execute` refuses the execution: the
   * run pauses at its step (its pending media fails, for a media-only
   * execution) with the classified failure, or the extraction fails.
   */
  readonly wrapExecution?: <T>(
    context: GenerationExecutionContext,
    execute: () => Promise<T>,
  ) => Promise<T>;
  /**
   * What a failure means, consulted before the built-in retry and failure
   * code decisions of a step, a media item and a material extraction.
   * Answer `undefined` for an error that is not the host's. Must not throw.
   */
  readonly classifyFailure?: (error: unknown) => GenerationFailureClassification | undefined;
  /**
   * Told after a run's transition committed, in commit order within a
   * process. Best effort and at most once: a process that stops between the
   * commit and the call does not repeat it, so the run's own event log is the
   * record and billing must not rely on these calls. The current owner is
   * looked up for a bounded time, and a process holds a bounded number of
   * notifications (a new one is dropped when full; see `./runtime.ts`). Not
   * awaited by the run; a throw or a rejection is logged and ignored.
   */
  readonly onRunEvent?: (event: GenerationRunHookEvent) => void | Promise<void>;
}
