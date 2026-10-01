/**
 * The shared shape of the course generation steps (RFC #1754 §E).
 *
 * Each step is the classic step logic the generation API routes used to hold,
 * as a plain `(input, ctx) => output` function: the routes, the server-side
 * runs and the Pro agent's tools call the same code, and only who orchestrates
 * the steps differs. A step knows nothing about HTTP. Request parsing, owner
 * resolution, access gates, status codes and response shapes stay with the
 * caller, which also resolves what a request names (the model, the
 * connection of a media slot, the web-search configuration) and hands the
 * result in, so the deprecated request fields never reach a step.
 */
import type { createLogger } from '@/lib/logger';
import type { VisionPromptImage } from '@/lib/persistence/resolve-vision-images';
import type { ResolvedModel } from '@/lib/server/resolve-model';

export type StepLogger = ReturnType<typeof createLogger>;

/** What every step may use besides its input. */
export interface StepContext<Event = never> {
  /**
   * The caller went away. Only the steps that support it honour it (today:
   * the outline step, which stops streaming); the others run to completion.
   */
  signal?: AbortSignal;
  log: StepLogger;
  /** Progress a step reports while it runs (outline deltas, retries). */
  emit?: (event: Event) => void;
}

/**
 * Resolves vision images whose `src` may be an allocated asset id to data
 * URLs, as the owner the step works for may read them; an image that does not
 * resolve is dropped (see resolveVisionImagesForPrompt).
 */
export type VisionImageResolver = (
  images: readonly VisionPromptImage[],
) => Promise<VisionPromptImage[]>;

/** A step that reads the stored images of the owner it works for. */
export interface OwnerStepContext<Event = never> extends StepContext<Event> {
  resolveVisionImages: VisionImageResolver;
}

/** A step that reads capability slots itself. */
export interface WorkspaceStepContext<Event = never> extends StepContext<Event> {
  /** The workspace whose capability slots apply; null for the deployment alone. */
  workspaceId: string | null;
}

/** The language model a step generates with, resolved by the caller for the step's stage. */
export type StepLanguageModel = Pick<
  ResolvedModel,
  'model' | 'modelInfo' | 'modelString' | 'thinkingConfig' | 'serverManaged'
>;

/**
 * A step declined its input, or the generation produced nothing usable. The
 * reason is step-specific and stable, so a caller can map it (a route to a
 * status code and error code, a run to a failed step); the message is the
 * text the caller shows.
 */
export class StepRefusal<Reason extends string = string> extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
  ) {
    super(message);
    this.name = 'StepRefusal';
  }
}

/** The caller went away (its signal aborted) while the step was running. */
export class StepAbortedError extends Error {
  constructor() {
    super('The generation step was aborted');
    this.name = 'StepAbortedError';
  }
}
