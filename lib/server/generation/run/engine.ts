/**
 * The run engine: executes a claimed run's steps in the classic order with the
 * context 1.1.x's browser generation threaded through them, committing each
 * step's checkpoint, the run's next state and its events in one transaction
 * fenced by the lease generation.
 *
 * What it replicates, step by step (1.1.x's generation preview for the outline
 * and the first scene, and its classroom for the rest):
 *
 * - research runs when the webSearch slot resolves, and the outline's
 *   requirements carry that decision as `webSearch`;
 * - the outline streams its items, then waits for confirmation (or is
 *   confirmed in its own commit, for `outlineReview: "auto"`; a `countdown`
 *   run waits until its deadline, when any runner confirms it);
 * - agents: generated (`auto`, falling back to the learner's selected presets
 *   when that fails) or the preset ids; the stage is named after the course
 *   title;
 * - scene by scene in outline order: content (the first scene with the full
 *   requirements and 2 retries; later scenes with the task-engine flag only
 *   and 5 retries), actions (every outline for the page index and titles, the
 *   speeches of the scene before, the learner profile, the language
 *   directive, the agents), narration of the speech actions when the tts slot
 *   narrates on the server, with the teacher's voice options and the same
 *   fallback when a voice clone is missing;
 * - the course document is created with the first scene, later scenes are
 *   appended as they complete, and `generationComplete` is set at the end;
 * - with a parallel scene concurrency above 1, the content of the scenes
 *   after the first is generated ahead (bounded) and consumed in order; a
 *   scene whose content fails is skipped and the run pauses at it once the
 *   other scenes are in;
 * - material images are stored as course assets by the material analysis,
 *   and the outline and the scenes are generated with them as the browser's
 *   session hands them over (by id, resolved for the vision prompt);
 * - the media the outline asks for is generated alongside the scenes once
 *   the course exists (`./media.ts`), and the run completes when every item
 *   has an answer. A media failure does not pause the run; a paused or
 *   completed run whose media is retried is executed for that media only.
 *
 * A step that fails after its retries pauses the run at that step. Deleting
 * the course ends the run in the deletion's own transaction (see the
 * owner-bound document store); a worker executing it loses its lease.
 */
import { isAbortError } from '@openmaic/generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { pickNarratorAgent, resolveServerAgentVoiceOptions } from '@/lib/audio/agent-voice-options';
import { voiceBindingKey } from '@/lib/audio/unavailable-voice-bindings';
import type { ResolvedVoice } from '@/lib/audio/voice-resolver';

import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { validateAppScene } from '@/lib/document-store/validators';
import { sceneCarriesMediaReference } from '@/lib/media/generated-media-references';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { createLogger } from '@/lib/logger';
import { BUILT_IN_AGENTS } from '@/lib/orchestration/registry/built-in';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { generateClassroomId } from '@/lib/server/classroom-persistence';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import type { StepContext } from '@/lib/server/generation/steps/context';
import type { OutlineEvent, OutlineResult } from '@/lib/server/generation/steps/outline';
import type {
  SceneActionsInput,
  SceneActionsResult,
} from '@/lib/server/generation/steps/scene-actions';
import type { SceneContentResult } from '@/lib/server/generation/steps/scene-content';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageMapping, PdfImage, UserRequirements } from '@/lib/types/generation';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';
import { getGenerationRunHooks } from '@/lib/server/generation-run-hooks/registry';
import {
  classifyHostFailure,
  isNonRetryableHostFailure,
  runGenerationExecution,
} from '@/lib/server/generation-run-hooks/runtime';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';
import { lazyBoundedMap } from '@/lib/utils/concurrency';

import {
  appendRunScene,
  completeRunCourse,
  createRunCourse,
  isRunCourseDeleted,
  loadRunCourse,
  mutateRunScene,
  RunCourseDeletedError,
  touchRunCourseIn,
} from './document';
import {
  advertisedVoices,
  clipProviderConfig,
  clipVoice,
  clipVoiceAfterMissingClone,
  narratorVoiceForGeneration,
  slotVoice,
} from './narration-voice';
import {
  doneOf,
  endsLane,
  isMediaWork,
  MAX_PLACEMENT_ATTEMPTS,
  MEDIA_PLACEMENT_FAILED,
  mayGenerate,
  mediaEvent,
  ownerAssetExists,
  placeInScene,
  runMediaLane,
} from './media';
import {
  advanceRun,
  MEDIA_ELEMENT_REMOVED,
  mediaItemsOf,
  mediaStepId,
  SCENE_STEP_KINDS,
  sceneStepId,
  type RunMediaItem,
  type RunStep,
} from './plan';
import {
  FIRST_SCENE_MAX_RETRIES,
  SCENE_MAX_RETRIES,
  withRouteRetry,
  type RouteRetryOptions,
} from './retry';
import { STEP_DEADLINES_MS, withDeadline } from './deadline';
import { runFailureCode, type RunFailureCode } from './failure-code';
import { reportCommittedRunEvents } from './hook-events';
import type { RunMaterialImage, RunStepServices } from './services';
import {
  commitGenerationRun,
  commitGenerationRunIn,
  currentOwnerOf,
  fenceGenerationRunWriteIn,
  hasMediaWorkIn,
  isGenerationRunLeaseLostError,
  finishMediaOnlyRun,
  readGenerationRunMedia,
  readGenerationRunSteps,
  refuseGenerationRunExecution,
  type ClaimedRun,
  type StepCommit,
  type StoredRun,
} from './store';
import type {
  GenerationRunAgentsResult,
  GenerationRunCustomAgent,
  GenerationRunInput,
  GenerationRunMediaCheckpoint,
  GenerationRunOutline,
  NewGenerationRunEvent,
} from './types';

const log = createLogger('GenerationRun');

/** The avatars the agent-profiles step may pick from, as the generation preview offers them. */
const AGENT_AVATARS = [
  {
    path: '/avatars/teacher.png',
    desc: 'Male teacher with glasses, holding a book, green background',
  },
  {
    path: '/avatars/teacher-2.png',
    desc: 'Female teacher with long dark hair, blue traditional outfit, gentle expression',
  },
  {
    path: '/avatars/assist.png',
    desc: 'Young female assistant with glasses, pink background, friendly smile',
  },
  {
    path: '/avatars/assist-2.png',
    desc: 'Young female in orange top and purple overalls, cheerful and approachable',
  },
  {
    path: '/avatars/clown.png',
    desc: 'Energetic girl with glasses pointing up, green shirt, lively and fun',
  },
  {
    path: '/avatars/clown-2.png',
    desc: 'Playful girl with curly hair doing rock gesture, blue shirt, humorous vibe',
  },
  {
    path: '/avatars/curious.png',
    desc: 'Surprised boy with glasses, hand on cheek, curious expression',
  },
  {
    path: '/avatars/curious-2.png',
    desc: 'Boy with backpack holding a book and question mark bubble, inquisitive',
  },
  {
    path: '/avatars/note-taker.png',
    desc: 'Studious boy with glasses, blue shirt, calm and organized',
  },
  {
    path: '/avatars/note-taker-2.png',
    desc: 'Active boy with yellow backpack waving, blue outfit, enthusiastic learner',
  },
  {
    path: '/avatars/thinker.png',
    desc: 'Thoughtful girl with hand on chin, purple background, contemplative',
  },
  {
    path: '/avatars/thinker-2.png',
    desc: 'Girl reading a book intently, long dark hair, intellectual and focused',
  },
];

/** The preset agents a learner has before choosing any (the browser's settings default). */
export const DEFAULT_PRESET_AGENT_IDS = ['default-1', 'default-2', 'default-3'];

/** The topic a stage is named after until the outline names the course. */
function topicFromRequirement(requirement: string): string {
  const trimmed = requirement.trim();
  return trimmed.length <= 500 ? trimmed : trimmed.substring(0, 500).trim() + '...';
}

/** The learner profile line the actions step reads. */
export function learnerProfileText(input: GenerationRunInput): string | undefined {
  const { nickname, bio } = input.learnerProfile ?? {};
  return nickname || bio ? `Student: ${nickname || 'Unknown'}${bio ? ` — ${bio}` : ''}` : undefined;
}

/** The requirements the outline and the first scene are generated with. */
export function runRequirements(input: GenerationRunInput, webSearch: boolean): UserRequirements {
  return {
    requirement: input.requirement,
    ...(input.learnerProfile?.nickname ? { userNickname: input.learnerProfile.nickname } : {}),
    ...(input.learnerProfile?.bio ? { userBio: input.learnerProfile.bio } : {}),
    ...(webSearch ? { webSearch: true } : {}),
    ...(input.interactive ? { interactiveMode: true } : {}),
    ...(input.taskEngine ? { taskEngineMode: true } : {}),
  };
}

function speechesOf(scene: Scene): string[] {
  return (scene.actions ?? [])
    .filter((action): action is SpeechAction => action.type === 'speech')
    .map((action) => action.text);
}

interface MaterialOutput {
  pdfText: string;
  /** The material images, stored as assets of the course (`src` empty, `assetId` set). */
  pdfImages?: PdfImage[];
  /** Image id → asset id, as the content step resolves image elements. */
  imageMapping?: ImageMapping;
  /** The course's id, minted with its first assets. */
  stageId?: string;
}
interface ResearchOutput {
  webSearch: boolean;
  context?: string;
  sources?: Array<{ title: string; url: string }>;
}
interface AgentsOutput {
  agents: GenerationRunAgentsResult;
  stage: Stage;
}
interface NarrationOutput {
  scene: Scene;
}

/** How one execution of a run ended. */
export type RunExecutionOutcome =
  /** The run waits for a command, holding no worker. */
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'ended'
  /** The lease was lost or the process is stopping: whoever claims next resumes. */
  | 'interrupted';

export interface ExecuteRunOptions {
  services: RunStepServices;
  /** Aborted when the lease is lost or the process stops. */
  signal: AbortSignal;
  /** Called just before a commit that gives the lease up (the run waits, pauses or ends). */
  onLeaseReleased?: () => void;
}

/** Media was retried while the run was completing: the run goes on with it first. */
class MediaWorkPendingError extends Error {
  constructor() {
    super('The run has media to generate');
    this.name = 'MediaWorkPendingError';
  }
}

/** A failure that pauses the run at a step. */
class StepFailedError extends Error {
  constructor(
    readonly stepId: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message || 'The step failed' : String(cause));
    this.name = 'StepFailedError';
  }
}

/**
 * The code a failed step is reported with: the host's classification of its
 * own error first, then the built-in one (see `runFailureCode`).
 */
function failureCodeOf(error: unknown): RunFailureCode {
  const host = classifyHostFailure(error);
  if (host) {
    return {
      errorCode: host.errorCode,
      ...(host.statusCode !== undefined ? { statusCode: host.statusCode } : {}),
    };
  }
  return error instanceof InvalidSceneError
    ? { errorCode: 'GENERATION_FAILED' }
    : runFailureCode(error);
}

/** A generated scene the course cannot hold (it fails the document's own scene validation). */
class InvalidSceneError extends Error {
  constructor(stepId: string, problems: string) {
    super(`${stepId} produced a scene the course cannot hold: ${problems}`);
    this.name = 'InvalidSceneError';
  }
}

function assertValidScene(scene: unknown, stepId: string): void {
  const result = validateAppScene(scene);
  if (!result.valid) {
    throw new InvalidSceneError(
      stepId,
      result.errors
        .slice(0, 5)
        .map((error) => `${error.path}: ${error.message}`)
        .join('; '),
    );
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

/** The built-in agents the browser's registry always holds, ahead of a generated roster. */
function builtInAgents(): AgentConfig[] {
  return Object.values(BUILT_IN_AGENTS);
}

/** A roster entry as the registry holds it (for the narrator's voice options). */
function rosterAgent(
  agent: GeneratedAgentConfig | GenerationRunCustomAgent,
  generated: boolean,
): AgentConfig {
  return {
    ...agent,
    allowedActions: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    ...(generated ? { isGenerated: true } : {}),
  } as AgentConfig;
}

/**
 * Execute one claimed run to its next stop, inside the host's
 * `wrapExecution` when one is registered. A wrapper that refuses the
 * execution (throws before running it) pauses the run at its step with the
 * failure, as a step that failed for good would.
 */
export async function executeGenerationRun(
  claim: ClaimedRun,
  options: ExecuteRunOptions,
): Promise<RunExecutionOutcome> {
  const { run, lease, takeover } = claim;
  // Resolved only for a wrapper: the execution resolves it again itself.
  const currentOwnerId = getGenerationRunHooks().wrapExecution
    ? await currentOwnerOf(run.ownerId)
    : run.ownerId;
  const result = await runGenerationExecution(
    {
      kind: 'generation-run',
      runId: run.id,
      ownerId: run.ownerId,
      currentOwnerId,
      ...(run.stageId ? { stageId: run.stageId } : {}),
      attributes: run.hostAttributes ?? {},
      takeover,
    },
    () => executeClaimedRun(claim, options),
  );
  if (result.ran) return result.value;
  const { error } = result;
  log.warn(`run ${run.id}: the host refused its execution; pausing`, error);
  options.onLeaseReleased?.();
  return refuseGenerationRunExecution(lease, {
    message: error instanceof Error ? error.message || 'The execution was refused' : String(error),
    ...failureCodeOf(error),
  });
}

async function executeClaimedRun(
  claim: ClaimedRun,
  options: ExecuteRunOptions,
): Promise<RunExecutionOutcome> {
  const { lease } = claim;
  const { services, signal } = options;
  let run: StoredRun = claim.run;
  const input = run.input;
  // The owner the run works for now, refreshed at every step boundary: a
  // claim may move the run's owner into an account while it generates.
  let owner = await currentOwnerOf(run.ownerId);
  const steps = await readGenerationRunSteps(run.id);
  const output = <T>(stepId: string) => steps.get(stepId) as T | undefined;
  const commit = async (change: StepCommit) => {
    if (change.patch?.releaseLease) options.onLeaseReleased?.();
    const committed = await commitGenerationRun(lease, change);
    if (change.step) steps.set(change.step.id, change.step.output);
    for (const checkpoint of change.steps ?? []) steps.set(checkpoint.id, checkpoint.output);
    // Only a commit that changes the row moves the engine's view of it: the
    // content generated ahead and the retry events commit concurrently.
    if (change.patch) run = committed;
    if (change.events?.length) reportCommittedRunEvents(committed, change.events, currentOwnerOf);
  };
  const stepContext: StepContext = { log, signal };
  const retryOptions = (
    stepId: string,
    sceneIndex: number,
    refusalStatus: 400 | 500,
    retrySignal: AbortSignal = signal,
  ): RouteRetryOptions => ({
    label: `${run.id} ${stepId}`,
    maxRetries: sceneIndex === 0 ? FIRST_SCENE_MAX_RETRIES : SCENE_MAX_RETRIES,
    refusalStatus,
    sleep: services.sleep,
    signal: retrySignal,
    onRetry: async (event) => {
      log.warn(
        `run ${run.id}: retrying ${stepId} (${event.attempt}/${event.maxAttempts}): ${event.cause}`,
      );
      await commit({
        events: [
          {
            type: 'step_retry',
            data: {
              step: stepId,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              reason: event.reason,
              cause: event.cause,
            },
          },
        ],
      });
    },
  });

  const outline = () => {
    if (!run.outline) throw new Error(`Run ${run.id} has no confirmed outline`);
    return run.outline;
  };
  const agents = () => output<AgentsOutput>('agents')!;

  /** The material images, as the browser's session hands them to the outline and the scenes. */
  const materialImages = (): { pdfImages?: PdfImage[]; imageMapping?: ImageMapping } => {
    const material = output<MaterialOutput>('material-analysis');
    return material?.pdfImages?.length
      ? { pdfImages: material.pdfImages, imageMapping: material.imageMapping ?? {} }
      : {};
  };

  /** Store the material images as assets of the course-to-be (pending until a scene names one). */
  const storeMaterialImages = async (
    stageId: string,
    images: RunMaterialImage[],
  ): Promise<Pick<MaterialOutput, 'pdfImages' | 'imageMapping'>> => {
    const pdfImages: PdfImage[] = [];
    const imageMapping: ImageMapping = {};
    const allocated: string[] = [];
    try {
      for (const { bytes, mimeType, ...image } of images) {
        const stored = await storeGeneratedAsset({
          ownerId: owner,
          stageId,
          bytes,
          mimeType,
          kind: 'image',
          fence: (tx) => fenceGenerationRunWriteIn(tx, lease),
        });
        if (stored.status === 'refused') {
          throw new Error('Asset storage is full; the material images could not be stored');
        }
        allocated.push(stored.assetId);
        pdfImages.push({ ...image, src: '', assetId: stored.assetId });
        imageMapping[image.id] = stored.assetId;
      }
    } catch (error) {
      await services.releaseAssets(owner, allocated, stepContext);
      throw error;
    }
    return { pdfImages, imageMapping };
  };

  // ── Scene content, possibly generated ahead ──
  const generateContent = async (
    sceneIndex: number,
    contentSignal: AbortSignal,
  ): Promise<SceneContentResult> => {
    const { outlines, languageDirective, taskEngineMode } = outline();
    const stepId = sceneStepId(sceneIndex, 'content');
    const research = output<ResearchOutput>('research');
    return withRouteRetry(
      () =>
        withDeadline(stepId, STEP_DEADLINES_MS.sceneContent, contentSignal, (callSignal) =>
          services.sceneContent(
            owner,
            {
              outline: outlines[sceneIndex]!,
              ...materialImages(),
              agents: agents().agents.agents,
              languageDirective,
              // The first scene is generated with the session's requirements;
              // the classroom generates the rest with the task-engine flag only.
              requirements:
                sceneIndex === 0
                  ? runRequirements(input, research?.webSearch === true)
                  : taskEngineMode
                    ? ({ taskEngineMode: true } as UserRequirements)
                    : undefined,
            },
            { log, signal: callSignal },
          ),
        ),
      retryOptions(stepId, sceneIndex, 500, contentSignal),
    );
  };
  // Content generated ahead, by scene index (a holder: closures assign it).
  // Its calls get their own signal, aborted before the run pauses.
  const ahead: {
    prewarm: Map<number, Promise<SceneContentResult | { failed: unknown }>> | null;
  } = { prewarm: null };
  const prewarmAbort = new AbortController();
  const prewarmSignal = AbortSignal.any([signal, prewarmAbort.signal]);
  const startContentPrewarm = (fromIndex: number) => {
    const concurrency = services.parallelSceneConcurrency();
    const sceneCount = outline().outlines.length;
    const pending: number[] = [];
    for (let index = fromIndex; index < sceneCount; index += 1) {
      if (!steps.has(sceneStepId(index, 'content'))) pending.push(index);
    }
    if (concurrency <= 1 || pending.length <= 1) return;
    const promises = lazyBoundedMap(
      pending,
      concurrency,
      async (sceneIndex) => {
        try {
          const result = await generateContent(sceneIndex, prewarmSignal);
          await commit({
            step: { id: sceneStepId(sceneIndex, 'content'), output: result },
            events: [
              { type: 'step_completed', data: { step: sceneStepId(sceneIndex, 'content') } },
            ],
          });
          return result;
        } catch (error) {
          return { failed: error };
        }
      },
      { shouldContinue: () => !prewarmSignal.aborted },
    );
    ahead.prewarm = new Map(
      pending.map((sceneIndex, i) => [
        sceneIndex,
        promises[i]!.then(
          (result) => result ?? { failed: new Error('Content generation was not started') },
        ),
      ]),
    );
  };
  // In parallel mode the browser marks a scene whose content failed and goes
  // on with the others, pausing once they are done; these are those scenes.
  const skippedScenes = new Map<number, { message: string } & RunFailureCode>();
  const skippedStepIds = () =>
    [...skippedScenes.keys()].flatMap((index) =>
      SCENE_STEP_KINDS.map((kind) => sceneStepId(index, kind)),
    );

  // Voice bindings this execution found unusable (a deleted clone).
  const unavailableBindings = new Set<string>();

  // ── One step ──
  /** What a step commits; `null` for a scene skipped in parallel mode. */
  const runStep = async (step: RunStep): Promise<StepCommit | null> => {
    const stepId = step.id;
    const done = (value: unknown, extra: Partial<StepCommit> = {}): StepCommit => ({
      step: { id: stepId, output: value },
      patch: extra.patch,
      events: [{ type: 'step_completed', data: { step: stepId } }, ...(extra.events ?? [])],
    });

    switch (step.kind) {
      case 'material-analysis': {
        // Materials are extracted since their upload. Only a run that waits
        // for an extraction tells the preview what it waits on (the kind of
        // material it names); one whose materials are all ready reads their
        // results and shows no analysis.
        if (!(await services.materialsReady(owner, input.materialIds))) {
          const kinds = await services.materialKinds(owner, input.materialIds);
          await commit({ events: [{ type: 'material_kinds', data: { kinds } }] });
        }
        // No step deadline around the wait: a material queued behind other
        // extractions waits its turn, and each extraction has the step's
        // budget once a worker runs it (awaitOwnerMaterialExtractions).
        const analyzed = await services.analyzeMaterials(owner, input.materialIds, {
          log,
          signal,
        });
        // What the outline will not see in full, as the preview warns about it.
        const warnings = analyzed.truncated
          ? { events: [{ type: 'material_truncated' as const, data: { ...analyzed.truncated } }] }
          : {};
        if (analyzed.images.length === 0) {
          return done({ pdfText: analyzed.text } satisfies MaterialOutput, warnings);
        }
        // The images become assets of the course, whose id is minted now.
        const stageId = generateClassroomId();
        return done(
          {
            pdfText: analyzed.text,
            ...(await storeMaterialImages(stageId, analyzed.images)),
            stageId,
          } satisfies MaterialOutput,
          warnings,
        );
      }

      case 'research': {
        const pdfText = output<MaterialOutput>('material-analysis')?.pdfText;
        const result = await withDeadline(
          stepId,
          STEP_DEADLINES_MS.research,
          signal,
          (callSignal) =>
            services.research(
              owner,
              { query: input.requirement, ...(pdfText ? { pdfText } : {}) },
              { log, signal: callSignal },
            ),
        );
        const sources = (result?.sources ?? []).map((source) => ({
          title: source.title,
          url: source.url,
        }));
        return done(
          {
            webSearch: result !== null,
            ...(result ? { context: result.context || '', sources } : {}),
          } satisfies ResearchOutput,
          result ? { events: [{ type: 'research_sources', data: { sources } }] } : {},
        );
      }

      case 'outline':
        return runOutlineStep(stepId);

      case 'agents': {
        const resolved = await resolveAgents();
        return done(resolved, {
          patch: { agents: resolved.agents },
          events: [
            {
              type: 'agents',
              data: {
                agents: resolved.agents.generatedAgentConfigs ?? resolved.agents.agents,
              },
            },
          ],
        });
      }

      case 'content': {
        const pending = ahead.prewarm?.get(step.sceneIndex);
        if (pending) {
          const result = await pending;
          if ('failed' in result) {
            if (isAbortError(result.failed) || signal.aborted) throw result.failed;
            if (isGenerationRunLeaseLostError(result.failed)) throw result.failed;
            // A host failure no retry helps (the other scenes would meet it
            // too) pauses the run at this scene now.
            if (isNonRetryableHostFailure(result.failed)) throw result.failed;
            // Mark the scene and go on with the others.
            const message =
              result.failed instanceof Error
                ? result.failed.message || 'The step failed'
                : String(result.failed);
            log.warn(`run ${run.id}: ${stepId} failed; continuing with the other scenes`);
            const code = failureCodeOf(result.failed);
            skippedScenes.set(step.sceneIndex, { message, ...code });
            await commit({
              events: [
                {
                  type: 'step_failed',
                  data: { step: stepId, message, ...code, continuing: true },
                },
              ],
            });
            return null;
          }
          // Committed when it completed; nothing more to record.
          return {};
        }
        return done(await generateContent(step.sceneIndex, signal));
      }

      case 'actions': {
        const index = step.sceneIndex;
        const { outlines, languageDirective } = outline();
        const content = output<SceneContentResult>(sceneStepId(index, 'content'))!;
        const userProfile = learnerProfileText(input);
        const result = await withRouteRetry(
          () =>
            withDeadline(stepId, STEP_DEADLINES_MS.sceneActions, signal, async (callSignal) => {
              const generated = await services.sceneActions(
                owner,
                {
                  outline: content.effectiveOutline || outlines[index]!,
                  allOutlines: outlines,
                  // The route receives the content as JSON; so does this step.
                  content: content.content as SceneActionsInput['content'],
                  stageId: agents().stage.id,
                  agents: agents().agents.agents,
                  previousSpeeches: previousSpeechesFor(index),
                  ...(userProfile ? { userProfile } : {}),
                  languageDirective,
                },
                { log, signal: callSignal },
              );
              // The complete scene must be one the course can hold before it is
              // checkpointed: an invalid one (an action the model left without a
              // type, say) fails this step, which regenerates it, rather than
              // reaching narration and failing there for good.
              assertValidScene(generated.scene, stepId);
              return generated;
            }),
          retryOptions(stepId, index, 500),
        );
        return done(result);
      }

      case 'narration':
        // Narration commits itself, with the scene's document write.
        await narrateScene(step.sceneIndex, stepId);
        return {};
    }
  };

  /**
   * The speeches of the scene before, as the browser threads them: none for
   * the first scene; the stored first scene's (after narration split its long
   * lines) for the scene the classroom starts with; else the actions result of
   * the last scene generated before this one.
   */
  const previousSpeechesFor = (index: number): string[] => {
    for (let before = index - 1; before >= 0; before -= 1) {
      if (before === 0) {
        const first = output<NarrationOutput>(sceneStepId(0, 'narration'));
        return first ? speechesOf(first.scene) : [];
      }
      const actions = output<SceneActionsResult>(sceneStepId(before, 'actions'));
      if (actions) return actions.previousSpeeches ?? [];
    }
    return [];
  };

  const runOutlineStep = async (stepId: string): Promise<StepCommit> => {
    const research = output<ResearchOutput>('research');
    const pdfText = output<MaterialOutput>('material-analysis')?.pdfText;
    // Outline items reach subscribers while the model writes: each is
    // appended (fenced) in order, and the final commit waits for them.
    let appending: Promise<unknown> = Promise.resolve();
    let appendFailure: unknown;
    const append = (events: NewGenerationRunEvent[]) => {
      appending = appending
        .then(() => commit({ events }))
        .catch((error) => {
          appendFailure ??= error;
        });
    };
    const emit = (event: OutlineEvent) => {
      switch (event.type) {
        case 'languageDirective':
          append([{ type: 'outline_language_directive', data: { data: event.data } }]);
          break;
        case 'courseTitle':
          append([{ type: 'outline_course_title', data: { data: event.data } }]);
          break;
        case 'outline':
          append([{ type: 'outline_item', data: { index: event.index, outline: event.data } }]);
          break;
        case 'retry':
          append([
            { type: 'outline_reset', data: {} },
            {
              type: 'step_retry',
              data: {
                step: stepId,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                ...(event.fallback ? { fallback: event.fallback } : {}),
              },
            },
          ]);
          break;
      }
    };
    let result: OutlineResult;
    try {
      result = await withDeadline(stepId, STEP_DEADLINES_MS.outline, signal, (callSignal) =>
        services.outline(
          owner,
          {
            requirements: runRequirements(input, research?.webSearch === true),
            ...(pdfText ? { pdfText } : {}),
            ...materialImages(),
            ...(research?.context ? { researchContext: research.context } : {}),
          },
          { log, signal: callSignal, emit },
        ),
      );
    } finally {
      await appending;
    }
    if (appendFailure) throw appendFailure;
    // The outline in the normal form a confirmation takes, so the outline
    // as generated is always confirmable unchanged.
    const normalized = normalizeSceneOutlines(result.outlines);
    if (!normalized.ok) throw new Error(`The generated outline is unusable: ${normalized.message}`);
    result = { ...result, outlines: normalized.value };
    const confirmed: GenerationRunOutline = {
      outlines: result.outlines,
      languageDirective: result.languageDirective,
      ...(result.courseTitle ? { courseTitle: result.courseTitle } : {}),
      taskEngineMode: result.taskEngineMode,
    };
    // The run waits for confirmation holding no worker, unless its caller
    // asked for the outline to be confirmed with it. A `countdown` run (as the
    // row says at this commit: a hold may have turned it into a `wait` one
    // while the outline streamed) waits until its deadline.
    const automatic = input.outlineReview === 'auto';
    const next = automatic ? 'generating' : 'awaiting_outline_confirmation';
    return {
      step: { id: stepId, output: result },
      patch: {
        state: next,
        step: null,
        outline: confirmed,
        outlineRevision: 1,
        scenesTotal: result.outlines.length,
        ...(automatic ? {} : { releaseLease: true, outlineAutoConfirm: true }),
      },
      events: [
        { type: 'step_completed', data: { step: stepId } },
        { type: 'outline_ready', data: { revision: 1, outline: confirmed } },
        ...(automatic
          ? [
              {
                type: 'outline_confirmed' as const,
                data: { revision: 1, edited: false, automatic: true },
              },
            ]
          : []),
        { type: 'state', data: { state: next, step: null } },
      ],
    };
  };

  const resolveAgents = async (): Promise<AgentsOutput> => {
    const { outlines, languageDirective, courseTitle, taskEngineMode } = outline();
    const name = courseTitle || topicFromRequirement(input.requirement);
    const presets = async (agentIds: readonly string[]): Promise<GenerationRunAgentsResult> => {
      const configs = await services.presetAgents(owner, agentIds);
      return {
        agents: configs.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          persona: agent.persona,
        })),
        agentIds: configs.map((agent) => agent.id),
        ...(configs.some((agent) => !agent.isDefault)
          ? {
              customAgents: configs
                .filter((agent) => !agent.isDefault)
                .map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  role: agent.role,
                  persona: agent.persona,
                  avatar: agent.avatar,
                  color: agent.color,
                  priority: agent.priority,
                  ...(agent.voiceConfig ? { voiceConfig: agent.voiceConfig } : {}),
                  ...(agent.voiceDesign ? { voiceDesign: agent.voiceDesign } : {}),
                })),
            }
          : {}),
      };
    };
    let result: GenerationRunAgentsResult;
    if (input.agents.mode === 'auto') {
      try {
        const target = await services.narrationTarget(owner);
        const profiles = await withDeadline(
          'agents',
          STEP_DEADLINES_MS.agentProfiles,
          signal,
          (callSignal) =>
            services.agentProfiles(
              owner,
              {
                stageInfo: { name, description: '' },
                sceneOutlines: outlines.map((o) => ({
                  title: o.title,
                  description: o.description,
                })),
                languageDirective,
                availableAvatars: AGENT_AVATARS.map((a) => a.path),
                avatarDescriptions: AGENT_AVATARS.map((a) => ({ path: a.path, desc: a.desc })),
                availableVoices: target ? advertisedVoices(target) : [],
                narratorVoice: target ? narratorVoiceForGeneration(target, input.voice) : undefined,
              },
              { log, signal: callSignal },
            ),
        );
        result = {
          agents: profiles.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            persona: agent.persona,
          })),
          agentIds: profiles.map((agent) => agent.id),
          generatedAgentConfigs: profiles,
        };
      } catch (error) {
        if (isAbortError(error)) throw error;
        // A host failure no retry helps pauses the run here instead.
        if (isNonRetryableHostFailure(error)) throw error;
        // As the browser does: the learner's selected preset agents teach.
        log.warn(`run ${run.id}: agent generation failed, falling back to presets:`, error);
        // Never an empty roster: without a selection, the browser's default one.
        const selected = input.agents.presetAgentIds ?? [];
        result = await presets(selected.length > 0 ? selected : DEFAULT_PRESET_AGENT_IDS);
      }
    } else {
      // No agents selected: the default presets, as the learner's selection
      // starts out.
      const selected = input.agents.agentIds;
      result = await presets(selected.length > 0 ? selected : DEFAULT_PRESET_AGENT_IDS);
    }
    const now = Date.now();
    const stage: Stage = {
      id: output<MaterialOutput>('material-analysis')?.stageId ?? generateClassroomId(),
      name,
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
      interactiveMode: input.interactive,
      taskEngineMode,
      languageDirective,
      agentIds: result.agentIds,
      ...(result.generatedAgentConfigs
        ? { generatedAgentConfigs: result.generatedAgentConfigs }
        : {}),
      videoManifest: buildVideoManifestFromOutlines(outlines),
    };
    return { agents: result, stage };
  };

  const narrateScene = async (sceneIndex: number, stepId: string): Promise<void> => {
    const actions = output<SceneActionsResult>(sceneStepId(sceneIndex, 'actions'))!;
    const scene: Scene = structuredClone(actions.scene) as Scene;
    const target = await services.narrationTarget(owner);
    if (!target) {
      await appendScene(sceneIndex, stepId, scene);
      return;
    }
    scene.actions = splitLongSpeechActions(scene.actions || [], target.providerId);
    const speechActions = scene.actions.filter(
      (action): action is SpeechAction => action.type === 'speech' && !!action.text,
    );
    // The narrator as the browser's registry finds it: the built-in agents
    // first, then the owner's custom agents, then the course's generated roster.
    const teacher = pickNarratorAgent([
      ...builtInAgents(),
      ...(agents().agents.customAgents ?? []).map((agent) => rosterAgent(agent, false)),
      ...(agents().agents.generatedAgentConfigs ?? []).map((agent) => rosterAgent(agent, true)),
    ]);
    const bound = teacher?.voiceConfig;
    const { speed } = slotVoice(target, input.voice);
    const stageId = agents().stage.id;
    const { languageDirective } = outline();
    const allocated: string[] = [];
    // Clips left silent: the asset store refused them, or the voice is not the slot's.
    let unvoiced = 0;
    const fence = (tx: Queryable) => fenceGenerationRunWriteIn(tx, lease);

    const narrate = async (
      action: SpeechAction,
      override?: ResolvedVoice,
      hops = 0,
    ): Promise<string | null> => {
      const chosen = clipVoice({
        target,
        preference: input.voice,
        bound,
        unavailable: unavailableBindings,
        override,
      });
      // A voice of a provider the slot does not name stays unvoiced.
      if (!chosen) return null;
      const { voice, globalVoice } = chosen;
      const providerOptions = await resolveServerAgentVoiceOptions(teacher, {
        providerId: voice.providerId,
        providerConfig: clipProviderConfig(target, voice),
        voiceId: voice.voiceId,
        language: languageDirective,
      });
      try {
        return await withRouteRetry(
          () =>
            withDeadline(stepId, STEP_DEADLINES_MS.narrationClip, signal, (callSignal) =>
              services.narrateClip(
                owner,
                {
                  target,
                  stageId,
                  text: action.text,
                  audioId: `tts_s${scene.order}_${action.id}`,
                  voice: voice.voiceId,
                  speed,
                  ...(providerOptions ? { providerOptions } : {}),
                  fence,
                },
                { log, signal: callSignal },
              ),
            ),
          retryOptions(stepId, sceneIndex, 400),
        );
      } catch (error) {
        // The bound voice's clone is gone: one retry with a different voice.
        if (
          errorCode(error) === 'QWEN_VC_VOICE_NOT_FOUND' &&
          bound &&
          hops < 1 &&
          voiceBindingKey(voice) === voiceBindingKey(bound)
        ) {
          unavailableBindings.add(voiceBindingKey(bound));
          const retryVoice = clipVoiceAfterMissingClone({
            target,
            bound,
            globalVoice,
            failed: voice,
            usedFallbackVoice: !!override,
          });
          if (retryVoice) return narrate(action, retryVoice, hops + 1);
        }
        throw error;
      }
    };
    const narrateOne = async (action: SpeechAction) => {
      const assetId = await narrate(action);
      if (assetId) {
        allocated.push(assetId);
        action.audioId = assetId;
      } else {
        unvoiced += 1;
      }
    };
    try {
      const concurrency = services.parallelSceneConcurrency();
      // The clips and the scene that names them commit together; a failure
      // anywhere here retries both.
      if (concurrency > 1 && speechActions.length > 1) {
        const settled = await Promise.allSettled(
          lazyBoundedMap(speechActions, concurrency, narrateOne),
        );
        const rejected = settled.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (rejected) throw rejected.reason;
      } else {
        for (const action of speechActions) await narrateOne(action);
      }
      if (unvoiced > 0) {
        log.warn(`run ${run.id}: ${stepId} left ${unvoiced} speech clip(s) unvoiced`);
      }
      await appendScene(sceneIndex, stepId, scene, unvoiced);
    } catch (error) {
      // Nothing of this attempt committed: its clips are released (an entry
      // the scene's write did commit is not touched by the release).
      await services.releaseAssets(owner, allocated, stepContext);
      throw error;
    }
  };

  /**
   * Write the narrated scene into the course with the step's checkpoint, in
   * one transaction, with the media already stored for it in place.
   */
  const appendScene = (
    sceneIndex: number,
    stepId: string,
    scene: Scene,
    unvoiced = 0,
  ): Promise<void> =>
    exclusive(async () => {
      const media = await placeHeldMedia(scene);
      await writeScene(sceneIndex, stepId, scene, media, unvoiced);
    });

  /**
   * Put the media stored for `scene` in its slots: the items waiting for it
   * become done with its write, and an item already placed elsewhere names
   * its asset here too. Held bytes are checked first: the run keeps them
   * alive, so bytes that are gone are a fault, and the item fails loud (with
   * a Retry) instead of the scene naming nothing.
   */
  const placeHeldMedia = async (scene: Scene): Promise<StepCommit> => {
    const placed: NonNullable<StepCommit['steps']> = [];
    const events: NewGenerationRunEvent[] = [];
    owner = await currentOwnerOf(run.ownerId);
    for (const { request } of mediaItems()) {
      const checkpoint = mediaCheckpoint(request.elementId);
      if (checkpoint?.status !== 'stored' && checkpoint?.status !== 'done') continue;
      if (!sceneCarriesMediaReference(scene, request.elementId)) continue;
      if (checkpoint.status === 'stored' && !(await ownerAssetExists(owner, checkpoint.assetId))) {
        const failed: GenerationRunMediaCheckpoint = {
          mediaType: request.type,
          status: 'failed',
          message: `The stored ${request.type} was gone before its scene was written`,
        };
        placed.push({ id: mediaStepId(request.elementId), output: failed });
        events.push(mediaEvent(request.elementId, failed));
        continue;
      }
      placeInScene(scene, request.elementId, checkpoint);
      if (checkpoint.status === 'stored') {
        const done = doneOf(checkpoint);
        placed.push({ id: mediaStepId(request.elementId), output: done });
        events.push(mediaEvent(request.elementId, done));
      }
    }
    return { steps: placed, events };
  };

  const writeScene = async (
    sceneIndex: number,
    stepId: string,
    scene: Scene,
    media: StepCommit,
    unvoiced: number,
  ): Promise<void> => {
    const { stage } = agents();
    const change: StepCommit = {
      step: { id: stepId, output: { scene } satisfies NarrationOutput },
      steps: media.steps,
      patch: {
        // The scenes in the course: every narrated scene, this one included.
        scenesCompleted:
          [...steps.keys()].filter((id) => id !== stepId && id.endsWith(':narration')).length + 1,
        ...(sceneIndex === 0 ? { stageId: stage.id } : {}),
        ...(unvoiced > 0 ? { narrationUnvoiced: unvoiced } : {}),
      },
      events: [
        { type: 'step_completed', data: { step: stepId } },
        ...(sceneIndex === 0
          ? [{ type: 'course_created' as const, data: { stageId: stage.id } }]
          : []),
        {
          type: 'scene_ready',
          data: {
            index: sceneIndex,
            sceneId: scene.id,
            order: scene.order,
            narrationUnvoiced: run.narrationUnvoiced + unvoiced,
          },
        },
        ...(media.events ?? []),
      ],
    };
    // The document write and the checkpoint that records it, in one
    // transaction (a retried append rewrites the same scene id).
    // The engine's view of the run moves only once the whole write committed.
    let committed: StoredRun | undefined;
    const inTransaction = async (tx: Queryable) => {
      committed = await commitGenerationRunIn(tx, lease, change);
    };
    if (sceneIndex === 0) {
      await createRunCourse({
        ownerId: owner,
        lease,
        stage,
        outlines: outline().outlines,
        firstScene: scene,
        inTransaction,
      });
    } else {
      await appendRunScene({
        ownerId: owner,
        lease,
        stageId: stage.id,
        scene,
        inTransaction,
      });
    }
    run = committed!;
    steps.set(stepId, change.step!.output);
    for (const checkpoint of change.steps ?? []) steps.set(checkpoint.id, checkpoint.output);
    reportCommittedRunEvents(run, change.events ?? [], currentOwnerOf);
  };

  // ── Media ──
  /** Scene writes and media placement take turns (one worker holds the run). */
  let writeChain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(body, body);
    writeChain = next.catch(() => undefined);
    return next;
  };
  const mediaItems = (): RunMediaItem[] => (run.outline ? mediaItemsOf(run.outline.outlines) : []);
  const mediaCheckpoint = (elementId: string) =>
    steps.get(mediaStepId(elementId)) as GenerationRunMediaCheckpoint | undefined;
  const courseExists = () => steps.has(sceneStepId(0, 'narration'));
  const hasMediaWork = () =>
    mediaItems().some((item) => isMediaWork(mediaCheckpoint(item.request.elementId)));

  /**
   * Write stored media into the scenes of the course that hold its
   * placeholder, the item's checkpoint with the last of them; false when no
   * scene holds it yet.
   */
  const placeMedia = (
    elementId: string,
    checkpoint: Extract<GenerationRunMediaCheckpoint, { status: 'done' }>,
    events: NewGenerationRunEvent[],
  ): Promise<boolean> =>
    exclusive(async () => {
      const carrying: Array<{ index: number; scene: Scene }> = [];
      outline().outlines.forEach((_, index) => {
        const narrated = output<NarrationOutput>(sceneStepId(index, 'narration'));
        if (narrated && sceneCarriesMediaReference(narrated.scene, elementId)) {
          carrying.push({ index, scene: narrated.scene });
        }
      });
      if (carrying.length === 0) return false;
      for (const [position, { index, scene }] of carrying.entries()) {
        const next = structuredClone(scene);
        placeInScene(next, elementId, checkpoint);
        const last = position === carrying.length - 1;
        const change: StepCommit = {
          // The narration checkpoint is the scene as the course holds it.
          steps: [
            {
              id: sceneStepId(index, 'narration'),
              output: { scene: next } satisfies NarrationOutput,
            },
            ...(last ? [{ id: mediaStepId(elementId), output: checkpoint }] : []),
          ],
          events: last ? events : [],
        };
        await appendRunScene({
          ownerId: owner,
          lease,
          stageId: agents().stage.id,
          scene: next,
          inTransaction: async (tx) => {
            await commitGenerationRunIn(tx, lease, change);
          },
        });
        for (const checkpointed of change.steps ?? [])
          steps.set(checkpointed.id, checkpointed.output);
      }
      return true;
    });

  /**
   * Place a Retry's media into a course that has completed, which its author
   * may be editing meanwhile. Each scene that holds the placeholder now is
   * read and rewritten in one transaction (only the matched slots change),
   * and the stage row is touched so an open editor reloads. The item is done
   * with the last scene written, so a crash in between leaves it stored and
   * the next execution places the rest. When the author removed the element
   * (or its scene), the result is dropped and its bytes released: the item
   * fails as {@link MEDIA_ELEMENT_REMOVED}, final, so the element is not
   * resurrected and no Retry pays for media nothing shows.
   */
  const placeIntoCurrentCourse = (
    elementId: string,
    checkpoint: Extract<GenerationRunMediaCheckpoint, { status: 'done' }>,
    events: NewGenerationRunEvent[],
  ): Promise<boolean> =>
    exclusive(async () => {
      owner = await currentOwnerOf(run.ownerId);
      const stageId = agents().stage.id;
      const course = await loadRunCourse({ ownerId: owner, lease, stageId });
      const candidates = course.scenes.filter((scene) =>
        sceneCarriesMediaReference(scene as Scene, elementId),
      );
      // Placed before an interruption: a scene already names these bytes.
      let placed = course.scenes.some((scene) =>
        sceneCarriesMediaReference(scene as Scene, checkpoint.assetId),
      );
      const finish = async (tx: Queryable) => {
        await commitGenerationRunIn(tx, lease, {
          step: { id: mediaStepId(elementId), output: checkpoint },
          events,
        });
      };
      for (const [position, candidate] of candidates.entries()) {
        const last = position === candidates.length - 1;
        await mutateRunScene({
          ownerId: owner,
          lease,
          stageId,
          sceneId: candidate.id,
          mutate: (scene) => {
            if (!scene) return null;
            const next = structuredClone(scene) as Scene;
            return placeInScene(next, elementId, checkpoint) ? next : null;
          },
          after: async (tx, wrote) => {
            if (wrote) {
              await touchRunCourseIn(tx, stageId);
              placed = true;
            }
            if (last && placed) await finish(tx);
          },
        });
      }
      if (placed) {
        // Placed before an interruption, with no scene left to write: done now.
        if (candidates.length === 0) {
          await commit({ step: { id: mediaStepId(elementId), output: checkpoint }, events });
        }
        steps.set(mediaStepId(elementId), checkpoint);
        return true;
      }
      log.info(`run ${run.id}: ${elementId} is no longer in the course; dropping its media`);
      await services.releaseAssets(
        owner,
        [checkpoint.assetId, ...(checkpoint.posterAssetId ? [checkpoint.posterAssetId] : [])],
        stepContext,
      );
      const dropped: GenerationRunMediaCheckpoint = {
        mediaType: checkpoint.mediaType,
        status: 'failed',
        message: `The ${checkpoint.mediaType} was generated after its element was removed from the course`,
        errorCode: MEDIA_ELEMENT_REMOVED,
      };
      await commit({
        step: { id: mediaStepId(elementId), output: dropped },
        events: [mediaEvent(elementId, dropped)],
      });
      return true;
    });

  /** Where stored media goes: the generated scenes, or a completed course as it is now. */
  const placeInto = () => (run.state === 'completed' ? placeIntoCurrentCourse : placeMedia);

  /**
   * Place stored bytes, counting the placements that fail: the bytes stay
   * stored (and are placed again later) until {@link MAX_PLACEMENT_ATTEMPTS}
   * failed in a row; then the item fails with a Retry and its bytes are
   * released, as every failed item's are (a Retry generates anew), so the run
   * stops being claimed for it.
   */
  const placer =
    () =>
    async (
      elementId: string,
      checkpoint: Extract<GenerationRunMediaCheckpoint, { status: 'done' }>,
      events: NewGenerationRunEvent[],
    ): Promise<boolean> => {
      try {
        return await placeInto()(elementId, checkpoint, events);
      } catch (error) {
        if (endsLane(error, signal)) throw error;
        const current = mediaCheckpoint(elementId);
        if (current?.status !== 'stored') throw error;
        const failures = (current.placementFailures ?? 0) + 1;
        log.warn(
          `run ${run.id}: placing ${elementId} failed (${failures}/${MAX_PLACEMENT_ATTEMPTS})`,
          error,
        );
        if (failures < MAX_PLACEMENT_ATTEMPTS) {
          await commit({
            step: {
              id: mediaStepId(elementId),
              output: { ...current, placementFailures: failures },
            },
          });
          return false;
        }
        await services.releaseAssets(
          owner,
          [current.assetId, ...(current.posterAssetId ? [current.posterAssetId] : [])],
          stepContext,
        );
        const failed: GenerationRunMediaCheckpoint = {
          mediaType: current.mediaType,
          status: 'failed',
          message: `The ${current.mediaType} could not be placed in the course`,
          errorCode: MEDIA_PLACEMENT_FAILED,
        };
        await commit({
          step: { id: mediaStepId(elementId), output: failed },
          events: [mediaEvent(elementId, failed)],
        });
        return true;
      }
    };

  const lane: {
    running: Promise<void> | null;
    /** What ended the lane and must end this execution (a lost lease or course). */
    failure: unknown;
    /** The pass of this execution queued what it found (and placed what a takeover left stored). */
    started: boolean;
    stopping: boolean;
    current: RunMediaItem | null;
    abort: AbortController;
  } = {
    running: null,
    failure: undefined,
    started: false,
    stopping: false,
    current: null,
    abort: new AbortController(),
  };

  /**
   * A fault of the media pass itself (its slots could not be read, a write
   * failed): the media work left fails, with a Retry, and the run goes on.
   * Bytes already stored stay stored and are placed later.
   */
  const failMediaWork = async (fault: unknown, items: RunMediaItem[] = mediaItems()) => {
    log.error(`run ${run.id}: the media pass failed; its remaining media fails`, fault);
    const failed = items.flatMap(({ request }) => {
      const current = mediaCheckpoint(request.elementId);
      if (current && !isMediaWork(current)) return [];
      const label = request.type === 'image' ? 'Image' : 'Video';
      const checkpoint: GenerationRunMediaCheckpoint = {
        mediaType: request.type,
        status: 'failed',
        message: `${label} generation failed`,
      };
      return [{ elementId: request.elementId, checkpoint }];
    });
    if (failed.length === 0) return;
    await commit({
      steps: failed.map(({ elementId, checkpoint }) => ({
        id: mediaStepId(elementId),
        output: checkpoint,
      })),
      events: failed.map(({ elementId, checkpoint }) => mediaEvent(elementId, checkpoint)),
    });
  };

  /**
   * Place the bytes stored before this execution (a takeover's, or a
   * placement that failed). They were kept alive, so bytes that are gone are
   * a fault: the item fails loud, with a Retry; a poster that is gone only
   * costs the poster.
   */
  const placeStoredMedia = async () => {
    owner = await currentOwnerOf(run.ownerId);
    for (const { request } of mediaItems()) {
      const checkpoint = mediaCheckpoint(request.elementId);
      if (checkpoint?.status !== 'stored') continue;
      if (!(await ownerAssetExists(owner, checkpoint.assetId))) {
        const failed: GenerationRunMediaCheckpoint = {
          mediaType: request.type,
          status: 'failed',
          message: `The stored ${request.type} was gone before it was placed`,
        };
        await commit({
          step: { id: mediaStepId(request.elementId), output: failed },
          events: [mediaEvent(request.elementId, failed)],
        });
        continue;
      }
      const posterKept =
        checkpoint.posterAssetId && (await ownerAssetExists(owner, checkpoint.posterAssetId));
      const done = doneOf(checkpoint);
      if (!posterKept) delete done.posterAssetId;
      await placer()(request.elementId, done, [mediaEvent(request.elementId, done)]);
    }
  };

  const startLane = (place: boolean) => {
    lane.stopping = false;
    lane.abort = new AbortController();
    const laneSignal = AbortSignal.any([signal, lane.abort.signal]);
    lane.running = (async () => {
      try {
        // Bytes a takeover found stored go where their scenes are now.
        if (place) await placeStoredMedia();
        await runMediaLane({
          runId: run.id,
          lease,
          signal: laneSignal,
          services,
          owner: () => owner,
          refreshOwner: async () => {
            owner = await currentOwnerOf(run.ownerId);
          },
          stageId: agents().stage.id,
          outline: outline(),
          items: mediaItems(),
          steps,
          commit,
          place: placer(),
          stopping: () => lane.stopping,
          onItemStarted: (item) => {
            lane.current = item;
          },
        });
      } catch (error) {
        if (endsLane(error, laneSignal)) throw error;
        await failMediaWork(error);
      }
    })()
      .catch((error) => {
        lane.failure = error;
      })
      .finally(() => {
        lane.running = null;
        lane.current = null;
      });
  };

  /** Adopt the media a Retry queued since this execution read the checkpoints. */
  const refreshMedia = async () => {
    for (const [elementId, checkpoint] of await readGenerationRunMedia(run.id)) {
      const current = mediaCheckpoint(elementId);
      if (
        checkpoint.status === 'queued' &&
        (current?.status === 'failed' || current?.status === 'skipped')
      ) {
        steps.set(mediaStepId(elementId), checkpoint);
      }
    }
  };

  /**
   * The pass queues every item it may generate that has no answer yet, as the
   * browser's pass enqueues its tasks; an item of a kind whose slot is off is
   * skipped (the browser leaves it to its next pass, which a Retry stands for
   * here), and one skipped before is queued once its slot resolves.
   */
  const queueMedia = async () => {
    const open = mediaItems().filter(({ request }) => {
      const current = mediaCheckpoint(request.elementId);
      return !current || current.status === 'skipped';
    });
    if (open.length === 0) return;
    let connections;
    try {
      connections = await services.mediaConnections(owner);
    } catch (error) {
      await failMediaWork(error, open);
      return;
    }
    const decided = open.flatMap(({ request }) => {
      const status: 'queued' | 'skipped' = mayGenerate(connections, request) ? 'queued' : 'skipped';
      if (mediaCheckpoint(request.elementId)?.status === status) return [];
      const checkpoint = { mediaType: request.type, status } as GenerationRunMediaCheckpoint;
      return [{ elementId: request.elementId, checkpoint }];
    });
    if (decided.length === 0) return;
    await commit({
      steps: decided.map(({ elementId, checkpoint }) => ({
        id: mediaStepId(elementId),
        output: checkpoint,
      })),
      events: decided.map(({ elementId, checkpoint }) => mediaEvent(elementId, checkpoint)),
    });
  };

  /** Keep the media pass going while the run generates, once the course exists. */
  const ensureMediaLane = async () => {
    if (lane.failure) throw lane.failure;
    if (lane.running) return;
    await refreshMedia();
    const first = !lane.started;
    if (first) {
      lane.started = true;
      await queueMedia();
    }
    if (first || hasMediaWork()) startLane(first);
  };

  /**
   * Wait until every media item has an answer (Retries queued meanwhile
   * included), and place the stored bytes a scene holds the placeholder of.
   */
  const settleMedia = async () => {
    for (;;) {
      if (lane.running) await lane.running;
      if (lane.failure) throw lane.failure;
      await refreshMedia();
      if (!lane.started || hasMediaWork()) {
        await ensureMediaLane();
        if (!lane.running) break;
        continue;
      }
      break;
    }
    try {
      await placeStoredMedia();
    } catch (error) {
      if (endsLane(error, signal)) throw error;
      // The bytes stay stored, and the completed run is claimed again to
      // place them (see `media_pending`); the course completes meanwhile.
      log.error(`run ${run.id}: placing stored media failed; it is tried again later`, error);
    }
  };

  /** Stop the pass: after the image in hand; a video's wait resumes on its task later. */
  const stopLane = async () => {
    lane.stopping = true;
    if (lane.current?.request.type === 'video') lane.abort.abort();
    if (lane.running) await lane.running;
  };

  /**
   * Bytes stored for a placeholder no generated scene holds: the course is
   * complete without them. Bytes a scene does hold stay stored (their
   * placement failed): the completed run is claimed again to place them.
   */
  const unplacedMedia = (): {
    steps: NonNullable<StepCommit['steps']>;
    events: NewGenerationRunEvent[];
  } => {
    const held = (elementId: string) =>
      outline().outlines.some((_, index) => {
        const narrated = output<NarrationOutput>(sceneStepId(index, 'narration'));
        return narrated ? sceneCarriesMediaReference(narrated.scene, elementId) : false;
      });
    const done = mediaItems().flatMap(({ request }) => {
      const checkpoint = mediaCheckpoint(request.elementId);
      return checkpoint?.status === 'stored' && !held(request.elementId)
        ? [{ elementId: request.elementId, checkpoint: doneOf(checkpoint) }]
        : [];
    });
    return {
      steps: done.map(({ elementId, checkpoint }) => ({
        id: mediaStepId(elementId),
        output: checkpoint,
      })),
      events: done.map(({ elementId, checkpoint }) => mediaEvent(elementId, checkpoint)),
    };
  };

  const pause = async (stepId: string, message: string, code: RunFailureCode) => {
    // Content generated ahead stops before the run pauses, and so does the
    // media pass (a paused run is claimed again for the media it has left).
    prewarmAbort.abort();
    await stopLane();
    await commit({
      patch: {
        state: 'paused',
        step: stepId,
        error: { step: stepId, message, ...code },
        releaseLease: true,
      },
      events: [
        { type: 'step_failed', data: { step: stepId, message, ...code } },
        { type: 'state', data: { state: 'paused', step: stepId } },
      ],
    });
  };

  const complete = async (): Promise<void> => {
    const stageId = agents().stage.id;
    let committed: StoredRun | undefined;
    const unplaced = unplacedMedia();
    const events: NewGenerationRunEvent[] = [
      ...unplaced.events,
      { type: 'completed', data: { stageId } },
      { type: 'state', data: { state: 'completed', step: null } },
    ];
    await completeRunCourse({
      ownerId: owner,
      lease,
      stageId,
      commit: async (tx) => {
        // A Retry that queued media since the pass settled is generated first.
        if (await hasMediaWorkIn(tx, run.id)) throw new MediaWorkPendingError();
        options.onLeaseReleased?.();
        committed = await commitGenerationRunIn(tx, lease, {
          steps: unplaced.steps,
          patch: { state: 'completed', step: null, releaseLease: true },
          events,
        });
      },
    });
    run = committed!;
    reportCommittedRunEvents(run, events, currentOwnerOf);
    for (const checkpoint of unplaced.steps) steps.set(checkpoint.id, checkpoint.output);
  };

  const end = async (stageId: string): Promise<void> => {
    await commit({
      patch: { state: 'ended', step: null, releaseLease: true },
      events: [
        { type: 'ended', data: { stageId } },
        { type: 'state', data: { state: 'ended', step: null } },
      ],
    });
  };

  /**
   * A paused or completed run claimed for its media: generate what is queued
   * (or resume a video's wait), then give the run up as it was; or, when a
   * step Retry made it executable meanwhile, go on with it ('resume').
   */
  const executeMediaOnly = async (): Promise<RunExecutionOutcome | 'resume'> => {
    const settled = run.state as 'paused' | 'completed';
    try {
      if (run.stageId && (await isRunCourseDeleted(run.stageId))) {
        await end(run.stageId);
        return 'ended';
      }
      lane.started = true;
      startLane(true);
      await lane.running;
      if (lane.failure) throw lane.failure;
      // Bytes still stored here failed to be placed: they stay stored, and a
      // completed run is claimed again for them (`media_pending`).
      run = await finishMediaOnlyRun(lease, [], []);
      if (run.state !== settled) {
        log.info(`run ${run.id}: retried while its media generated; going on with it`);
        lane.started = false;
        return 'resume';
      }
      options.onLeaseReleased?.();
      return settled;
    } catch (error) {
      if (error instanceof RunCourseDeletedError) {
        try {
          await end(error.stageId);
        } catch (endError) {
          if (!isGenerationRunLeaseLostError(endError)) throw endError;
        }
        return 'ended';
      }
      if (isGenerationRunLeaseLostError(error) || signal.aborted || isAbortError(error)) {
        return 'interrupted';
      }
      throw error;
    } finally {
      lane.abort.abort();
      if (lane.running) await lane.running;
    }
  };
  if (run.state === 'paused' || run.state === 'completed') {
    const outcome = await executeMediaOnly();
    if (outcome !== 'resume') return outcome;
  }

  try {
    for (;;) {
      if (signal.aborted) return 'interrupted';
      owner = await currentOwnerOf(run.ownerId);
      const advance = advanceRun({
        state: run.state,
        runInput: input,
        completed: new Set([...steps.keys(), ...skippedStepIds()]),
        sceneCount: run.outline?.outlines.length ?? 0,
      });
      if (advance.kind === 'await-outline-confirmation') {
        // Unreachable through commits (the outline's commit moves the run),
        // kept total for a row edited by hand.
        await commit({
          patch: { state: 'awaiting_outline_confirmation', step: null, releaseLease: true },
          events: [{ type: 'state', data: { state: 'awaiting_outline_confirmation', step: null } }],
        });
        return 'waiting';
      }
      if (run.stageId && (await isRunCourseDeleted(run.stageId))) {
        await end(run.stageId);
        return 'ended';
      }
      // The media pass runs alongside the scenes once the course exists.
      if (run.state === 'generating' && courseExists()) await ensureMediaLane();
      if (advance.kind === 'complete') {
        const [failedIndex, failure] =
          [...skippedScenes.entries()].sort(([a], [b]) => a - b)[0] ?? [];
        if (failedIndex !== undefined) {
          // Every other scene is in: pause at the first one that failed.
          const { message, ...code } = failure!;
          await pause(sceneStepId(failedIndex, 'content'), message, code);
          return 'paused';
        }
        // Every media item has an answer before the course is complete.
        await settleMedia();
        try {
          await complete();
        } catch (error) {
          if (error instanceof MediaWorkPendingError) continue;
          throw error;
        }
        return 'completed';
      }
      const { step, state } = advance;
      // The scenes after the first are generated ahead once the course
      // exists, as the classroom does when it takes over from the preview.
      if (!ahead.prewarm && step.kind === 'content' && step.sceneIndex >= 1) {
        startContentPrewarm(step.sceneIndex);
      }
      const restarted = run.step === step.id;
      await commit({
        patch: { state, step: step.id },
        events: [
          ...(state !== run.state
            ? [{ type: 'state' as const, data: { state, step: step.id } }]
            : []),
          ...(restarted && step.kind === 'outline'
            ? [{ type: 'outline_reset' as const, data: {} }]
            : []),
          { type: 'step_started', data: { step: step.id } },
        ],
      });
      let change: StepCommit | null;
      try {
        change = await runStep(step);
      } catch (error) {
        if (
          signal.aborted ||
          isAbortError(error) ||
          isGenerationRunLeaseLostError(error) ||
          error instanceof RunCourseDeletedError
        ) {
          throw error;
        }
        throw new StepFailedError(step.id, error);
      }
      if (change && (change.step || change.patch || change.events?.length)) await commit(change);
      if (run.state === 'awaiting_outline_confirmation') return 'waiting';
    }
  } catch (error) {
    prewarmAbort.abort();
    // A failed step pauses the run, which stops the media pass gently; any
    // other way out stops it now.
    if (!(error instanceof StepFailedError)) lane.abort.abort();
    if (error instanceof RunCourseDeletedError) {
      try {
        await end(error.stageId);
      } catch (endError) {
        // The deletion already ended the run (and took the lease with it).
        if (!isGenerationRunLeaseLostError(endError)) throw endError;
      }
      return 'ended';
    }
    if (isGenerationRunLeaseLostError(error) || signal.aborted || isAbortError(error)) {
      return 'interrupted';
    }
    if (error instanceof StepFailedError) {
      log.warn(`run ${run.id}: step ${error.stepId} failed; pausing`, error.cause);
      try {
        await pause(error.stepId, error.message, failureCodeOf(error.cause));
      } catch (pauseError) {
        if (isGenerationRunLeaseLostError(pauseError)) return 'interrupted';
        throw pauseError;
      }
      return 'paused';
    }
    throw error;
  } finally {
    prewarmAbort.abort();
    lane.abort.abort();
    if (ahead.prewarm) await Promise.allSettled(ahead.prewarm.values());
    if (lane.running) await lane.running;
  }
}
