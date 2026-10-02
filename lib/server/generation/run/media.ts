/**
 * The media lane of a run: the images and videos the confirmed outline asks
 * for, generated as 1.1.x's browser media pass generated them:
 *
 * - it starts once the course exists (1.1.x's browser started it when the
 *   classroom took over from the generation preview, after the first scene)
 *   and runs alongside the scenes, one item at a time, in outline order;
 * - only the kinds whose slot resolves are generated (a turned-off or
 *   unassigned slot leaves its placeholders, which render as disabled);
 * - the bytes go to the asset pool, and the course's slots that hold the
 *   item's placeholder are rewritten to the allocated id (a video's `src`
 *   and `mediaRef` together, its poster into an empty poster slot). An item
 *   whose scene is not in the course yet is held and written with that scene;
 * - a failure leaves the placeholder and does not stop the scenes or the
 *   other media; the item can be retried on its own. A full asset store stops
 *   the pass: the items not reached fail with the same reason.
 *
 * Every item is checkpointed (`media:<elementId>`, see
 * {@link GenerationRunMediaCheckpoint}): a video records its provider task at
 * submission and a takeover waits on that task again instead of submitting a
 * new one; stored bytes are checkpointed in the transaction that allocates
 * them, so a takeover places them instead of paying for them again.
 */
import { isAbortError } from '@openmaic/generation';
import { toAssetId } from '@openmaic/storage';

import { rewriteSceneMediaReference } from '@/lib/media/generated-media-references';
import { ASSET_QUOTA_EXCEEDED } from '@/lib/media/media-failure';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';
import type { Scene } from '@/lib/types/stage';

import { withDeadline } from './deadline';
import { isRetryableRunMedia, mediaStepId, type RunMediaItem } from './plan';
import type { RunMediaConnections, RunStepServices } from './services';
import {
  commitGenerationRunIn,
  fenceGenerationRunWriteIn,
  isGenerationRunLeaseLostError,
  type RunLease,
  type StepCommit,
} from './store';
import type {
  GenerationRunMediaCheckpoint,
  GenerationRunMediaState,
  GenerationRunOutline,
  NewGenerationRunEvent,
} from './types';

const log = createLogger('GenerationRunMedia');

/**
 * The budget of one image or video: the 300 s the image and video routes
 * declared on platforms that enforce one. A resumed video wait
 * gets a fresh one, as the provider's poll budget does.
 */
export const MEDIA_DEADLINE_MS = 300_000;

/** The statuses that still need the lane (stored bytes wait for their scene instead). */
export function isMediaWork(checkpoint: GenerationRunMediaCheckpoint | undefined): boolean {
  return (
    checkpoint?.status === 'queued' ||
    checkpoint?.status === 'generating' ||
    checkpoint?.status === 'submitted'
  );
}

/** The event a checkpoint reports, as the browser's media task states read. */
export function mediaEvent(
  elementId: string,
  checkpoint: GenerationRunMediaCheckpoint,
): NewGenerationRunEvent {
  return { type: 'media', data: { elementId, ...mediaState(checkpoint) } };
}

function mediaState(checkpoint: GenerationRunMediaCheckpoint): GenerationRunMediaState {
  const { mediaType } = checkpoint;
  switch (checkpoint.status) {
    case 'queued':
      return { mediaType, status: 'pending' };
    case 'generating':
    case 'submitted':
    // Stored bytes are done once the course names them.
    case 'stored':
      return { mediaType, status: 'generating' };
    case 'skipped':
      return { mediaType, status: 'disabled' };
    case 'done':
      return {
        mediaType,
        status: 'done',
        assetId: checkpoint.assetId,
        ...(checkpoint.posterAssetId ? { posterAssetId: checkpoint.posterAssetId } : {}),
      };
    case 'failed':
      return {
        mediaType,
        status: 'failed',
        message: checkpoint.message,
        ...(checkpoint.errorCode ? { errorCode: checkpoint.errorCode } : {}),
        retryable: isRetryableRunMedia(checkpoint),
      };
  }
}

/** The media states a run snapshot shows, by element id, for the media the run has reached. */
export function runMediaStates(
  checkpoints: ReadonlyMap<string, GenerationRunMediaCheckpoint>,
): Record<string, GenerationRunMediaState> {
  return Object.fromEntries(
    [...checkpoints.entries()].map(([elementId, checkpoint]) => [
      elementId,
      mediaState(checkpoint),
    ]),
  );
}

/** Whether the media pass generates this kind: its slot is not off. */
export function mayGenerate(
  connections: RunMediaConnections,
  request: Pick<MediaGenerationRequest, 'type'>,
): boolean {
  return (request.type === 'image' ? connections.image : connections.video).status !== 'off';
}

/**
 * What a failed item is remembered by: the code and the fixed message the
 * browser's generation route answers with (a provider's own error text is
 * only logged), so the element shows the same state and the same Retry rule.
 */
export function mediaFailure(
  error: unknown,
  mediaType: 'image' | 'video',
): { message: string; errorCode?: string } {
  const label = mediaType === 'image' ? 'Image' : 'Video';
  if (error instanceof StepRefusal) {
    const codes: Record<string, string> = {
      'missing-api-key': 'MISSING_API_KEY',
      'missing-model': 'MISSING_MODEL',
      'task-connection-changed': 'TASK_CONNECTION_CHANGED',
    };
    return {
      message: error.message,
      ...(codes[error.reason] ? { errorCode: codes[error.reason] } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'StepTimeoutError') return { message };
  if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
    return {
      message: `The ${mediaType} provider rejected this prompt under its content safety policy`,
      errorCode: 'CONTENT_SENSITIVE',
    };
  }
  return { message: `${label} generation failed` };
}

/** Whether the owner's asset pool still holds an allocation (a pending one expires). */
export async function ownerAssetExists(ownerId: string, assetId: string): Promise<boolean> {
  const { assetStore } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  try {
    return (
      (await assetStore.identify(assetPrincipalForOwner(ownerId), toAssetId(assetId))) !== null
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AssetNotFoundError') return false;
    throw error;
  }
}

/** Rewrite a scene's slots that hold `elementId`'s placeholder; whether any did. */
export function placeInScene(
  scene: Scene,
  elementId: string,
  stored: { assetId: string; posterAssetId?: string },
): boolean {
  return rewriteSceneMediaReference(scene, {
    placeholderRef: elementId,
    assetId: stored.assetId,
    ...(stored.posterAssetId ? { posterAssetId: stored.posterAssetId } : {}),
  });
}

/** What the lane needs from the engine executing its run. */
export interface MediaLaneContext {
  runId: string;
  lease: RunLease;
  /** Aborted when the run loses its lease or its course, or the lane must stop now. */
  signal: AbortSignal;
  services: RunStepServices;
  /** The owner the run works for now, followed through claims before each item. */
  owner(): string;
  refreshOwner(): Promise<void>;
  stageId: string;
  outline: GenerationRunOutline;
  items: readonly RunMediaItem[];
  /** The run's checkpoints, shared with the engine (media entries included). */
  steps: Map<string, unknown>;
  /** The engine's commit (it keeps `steps` current). */
  commit(change: StepCommit): Promise<void>;
  /**
   * Write stored bytes into the course's scenes that hold the placeholder,
   * with `checkpoint` (the item done) and `events` in the same transaction;
   * false, with nothing written, when no scene in the course holds it yet.
   */
  place(
    elementId: string,
    checkpoint: Extract<GenerationRunMediaCheckpoint, { status: 'done' }>,
    events: NewGenerationRunEvent[],
  ): Promise<boolean>;
  /** Asked between items: stop after the item in hand (the run is pausing). */
  stopping(): boolean;
  /** Told the item the lane works on now. */
  onItemStarted?(item: RunMediaItem): void;
}

/** A failure that ends the lane rather than one item: the run lost its lease or its course. */
export function endsLane(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    isAbortError(error) ||
    isGenerationRunLeaseLostError(error) ||
    (error instanceof Error && error.name === 'RunCourseDeletedError')
  );
}

/**
 * Generate the run's media work in outline order until none is left, one
 * item at a time. A failure of one item is that item's; what the lane throws
 * is either what ends it ({@link endsLane}) or a fault outside any item (the
 * slots could not be read, a placement write failed), which the engine
 * answers by failing the work left, never the run.
 */
export async function runMediaLane(ctx: MediaLaneContext): Promise<void> {
  await ctx.refreshOwner();
  const connections = await ctx.services.mediaConnections(ctx.owner());
  const checkpointOf = (item: RunMediaItem) =>
    ctx.steps.get(mediaStepId(item.request.elementId)) as GenerationRunMediaCheckpoint | undefined;
  const attempted = new Set<string>();
  for (;;) {
    if (ctx.signal.aborted || ctx.stopping()) return;
    const item = ctx.items.find(
      (candidate) =>
        isMediaWork(checkpointOf(candidate)) && !attempted.has(candidate.request.elementId),
    );
    if (!item) return;
    attempted.add(item.request.elementId);
    ctx.onItemStarted?.(item);
    await ctx.refreshOwner();
    const outcome = await generateItem(ctx, item, checkpointOf(item)!, connections);
    if (outcome.stored) {
      // Placing is not part of the item's failure: bytes that are stored stay
      // stored when a placement write fails, and are placed later.
      await placeStored(ctx, item.request.elementId, outcome.stored);
      continue;
    }
    if (!outcome.storageFull) continue;
    // The store had no room: the pass stops, as the browser's does, and the
    // items it has not reached show that reason with a Retry. The browser
    // keeps that state in memory and a later load of the course generates
    // them; a run has no later load, so the state is recorded instead.
    const rest = ctx.items.filter((candidate) => checkpointOf(candidate)?.status === 'queued');
    if (rest.length === 0) return;
    const failed = rest.map((candidate) => {
      const checkpoint: GenerationRunMediaCheckpoint = {
        mediaType: candidate.request.type,
        status: 'failed',
        message: `Asset storage is full; the ${candidate.request.type} was not generated`,
        errorCode: ASSET_QUOTA_EXCEEDED,
      };
      return { id: mediaStepId(candidate.request.elementId), checkpoint, candidate };
    });
    await ctx.commit({
      steps: failed.map(({ id, checkpoint }) => ({ id, output: checkpoint })),
      events: failed.map(({ candidate, checkpoint }) =>
        mediaEvent(candidate.request.elementId, checkpoint),
      ),
    });
    log.warn(`run ${ctx.runId}: asset storage is full; stopping the media pass`);
    return;
  }
}

/**
 * Placements of stored bytes that may fail in a row before the item fails:
 * past it the fault is not passing, and a completed run would otherwise be
 * claimed for the placement on every scan.
 */
export const MAX_PLACEMENT_ATTEMPTS = 3;

/** The code of an item whose bytes could not be placed in the course (retryable). */
export const MEDIA_PLACEMENT_FAILED = 'MEDIA_PLACEMENT_FAILED';

/** How many times a video's task record is written before the item gives up on it. */
const TASK_RECORD_ATTEMPTS = 3;

type StoredCheckpoint = Extract<GenerationRunMediaCheckpoint, { status: 'stored' }>;

/** Generate (or resume) one item, up to its stored bytes. */
async function generateItem(
  ctx: MediaLaneContext,
  item: RunMediaItem,
  checkpoint: GenerationRunMediaCheckpoint,
  connections: RunMediaConnections,
): Promise<{ stored?: StoredCheckpoint; storageFull?: boolean }> {
  const { request } = item;
  const { elementId, type: mediaType } = request;
  const stepId = mediaStepId(elementId);
  const owner = ctx.owner();
  const record = async (next: GenerationRunMediaCheckpoint) => {
    await ctx.commit({ step: { id: stepId, output: next }, events: [mediaEvent(elementId, next)] });
  };

  const slot = mediaType === 'image' ? connections.image : connections.video;
  if (slot.status === 'off') {
    // The slot was turned off since the item was queued: the element renders
    // as disabled, and a Retry generates it once the slot resolves.
    await record({ mediaType, status: 'skipped' });
    return {};
  }
  if (slot.status === 'refused') {
    // What the route answers for this slot (an endpoint or a credential it refuses).
    await record({ mediaType, status: 'failed', message: slot.message, errorCode: slot.errorCode });
    return {};
  }
  const { connection } = slot;

  // The task a takeover found submitted: its wait is resumed.
  const task = checkpoint.status === 'submitted' ? checkpoint.task : undefined;
  let posterAssetId: string | undefined;
  try {
    if (!task) await record({ mediaType, status: 'generating' });
    const fence = (tx: Parameters<typeof fenceGenerationRunWriteIn>[0]) =>
      fenceGenerationRunWriteIn(tx, ctx.lease);
    let media: { bytes: Uint8Array; mimeType: string };
    let poster: { bytes: Uint8Array; mimeType: string } | undefined;
    if (mediaType === 'image') {
      media = await withDeadline(stepId, MEDIA_DEADLINE_MS, ctx.signal, (signal) =>
        ctx.services.generateImage(
          owner,
          { request, stageId: ctx.stageId, connection },
          { log, signal },
        ),
      );
    } else {
      const resume = task;
      if (resume) log.info(`run ${ctx.runId}: resuming the wait on video task ${resume.taskId}`);
      const video = await withDeadline(stepId, MEDIA_DEADLINE_MS, ctx.signal, (signal) =>
        ctx.services.generateVideo(
          owner,
          {
            request,
            connection,
            ...(resume ? { resume } : {}),
            // Recorded before the wait, so a takeover waits on this
            // task. A write that fails for a passing reason is tried again in
            // place: the task is paid for.
            onProviderTask: async (submitted) => {
              for (let attempt = 1; ; attempt += 1) {
                try {
                  await ctx.commit({
                    step: {
                      id: stepId,
                      output: { mediaType, status: 'submitted', task: submitted },
                    },
                  });
                  return;
                } catch (error) {
                  if (endsLane(error, ctx.signal) || attempt >= TASK_RECORD_ATTEMPTS) throw error;
                  log.warn(
                    `run ${ctx.runId}: recording video task ${submitted.taskId} failed; again`,
                    error,
                  );
                  await ctx.services.sleep(500 * attempt, ctx.signal);
                }
              }
            },
          },
          { log, signal },
        ),
      );
      media = video.video;
      poster = video.poster;
    }

    // A poster is decorative: a failure to store it costs the poster only.
    if (poster) {
      try {
        const stored = await storeGeneratedAsset({
          ownerId: owner,
          stageId: ctx.stageId,
          bytes: poster.bytes,
          mimeType: poster.mimeType,
          kind: 'poster',
          fence,
        });
        if (stored.status === 'stored') posterAssetId = stored.assetId;
      } catch (error) {
        if (endsLane(error, ctx.signal)) throw error;
        log.warn(`run ${ctx.runId}: the poster of ${elementId} was not stored:`, error);
      }
    }

    // The bytes and their checkpoint commit together.
    let storedCheckpoint: StoredCheckpoint | undefined;
    const stored = await storeGeneratedAsset({
      ownerId: owner,
      stageId: ctx.stageId,
      bytes: media.bytes,
      mimeType: media.mimeType,
      kind: mediaType,
      fence,
      afterPut: async (tx, assetId) => {
        storedCheckpoint = {
          mediaType,
          status: 'stored',
          assetId,
          ...(posterAssetId ? { posterAssetId } : {}),
        };
        await commitGenerationRunIn(tx, ctx.lease, {
          step: { id: stepId, output: storedCheckpoint },
        });
      },
    });
    if (stored.status === 'refused') {
      await releasePoster(ctx, posterAssetId);
      await record({
        mediaType,
        status: 'failed',
        message: `Asset storage is full; the ${mediaType} was not generated`,
        errorCode: ASSET_QUOTA_EXCEEDED,
      });
      return { storageFull: true };
    }
    ctx.steps.set(stepId, storedCheckpoint);
    return { stored: storedCheckpoint! };
  } catch (error) {
    await releasePoster(ctx, posterAssetId);
    if (endsLane(error, ctx.signal)) throw error;
    log.warn(`run ${ctx.runId}: ${mediaType} ${elementId} failed:`, error);
    // A failed item lets go of its task: a Retry submits a new one, as the
    // browser's does. Only a takeover waits on a task again (see above).
    await record({ mediaType, status: 'failed', ...mediaFailure(error, mediaType) });
    return {};
  }
}

async function releasePoster(ctx: MediaLaneContext, posterAssetId: string | undefined) {
  if (!posterAssetId) return;
  await ctx.services.releaseAssets(ctx.owner(), [posterAssetId], { log });
}

/** The done checkpoint of stored bytes. */
export function doneOf(
  stored: StoredCheckpoint,
): Extract<GenerationRunMediaCheckpoint, { status: 'done' }> {
  return {
    mediaType: stored.mediaType,
    status: 'done',
    assetId: stored.assetId,
    ...(stored.posterAssetId ? { posterAssetId: stored.posterAssetId } : {}),
  };
}

/** Write stored bytes into the scenes that hold their placeholder, if any is in the course. */
export async function placeStored(
  ctx: Pick<MediaLaneContext, 'place'>,
  elementId: string,
  stored: StoredCheckpoint,
): Promise<boolean> {
  const done = doneOf(stored);
  return ctx.place(elementId, done, [mediaEvent(elementId, done)]);
}
