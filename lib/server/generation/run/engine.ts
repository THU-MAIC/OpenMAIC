/**
 * The run engine: executes a claimed run's steps in the browser's classic
 * order with the context the browser threads through them, committing each
 * step's checkpoint, the run's next state and its events in one transaction
 * fenced by the lease generation.
 *
 * What it replicates, step by step (`app/generation-preview/page.tsx` for the
 * outline and the first scene, `lib/hooks/use-scene-generator.ts` for the
 * rest, which the classroom resumes):
 *
 * - research runs when the webSearch slot resolves, and the outline's
 *   requirements carry that decision as `webSearch`;
 * - the outline streams its items, then waits for confirmation;
 * - agents: generated (`auto`, falling back to the default preset when that
 *   fails) or the preset ids; the stage is named after the course title;
 * - scene by scene in outline order: content (the first scene with the full
 *   requirements and 2 retries; later scenes with the task-engine flag only
 *   and 5 retries), actions (every outline for the page index and titles, the
 *   speeches of the scene before, the learner profile, the language
 *   directive, the agents), narration of the speech actions when the tts slot
 *   narrates on the server;
 * - the course document is created with the first scene, later scenes are
 *   appended as they complete, and `generationComplete` is set at the end;
 * - with a parallel scene concurrency above 1, the content of the scenes
 *   after the first is generated ahead (bounded) and consumed in order.
 *
 * A step that fails after its retries pauses the run at that step; deleting
 * the course ends the run at the next step boundary.
 */
import type { AgentInfo } from '@openmaic/generation';
import { isAbortError } from '@openmaic/generation';

import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { createLogger } from '@/lib/logger';
import { markStageGenerationComplete } from '@/lib/persistence/stage-meta';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { generateClassroomId } from '@/lib/server/classroom-persistence';
import type { StepContext } from '@/lib/server/generation/steps/context';
import type { OutlineEvent, OutlineResult } from '@/lib/server/generation/steps/outline';
import type {
  SceneActionsInput,
  SceneActionsResult,
} from '@/lib/server/generation/steps/scene-actions';
import type { SceneContentResult } from '@/lib/server/generation/steps/scene-content';
import type { SpeechAction } from '@/lib/types/action';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { lazyBoundedMap } from '@/lib/utils/concurrency';

import {
  appendRunScene,
  completeRunCourse,
  createRunCourse,
  isRunCourseDeleted,
  RunCourseDeletedError,
} from './document';
import {
  advertisedVoices,
  clipVoice,
  narratorVoiceForGeneration,
  slotVoice,
} from './narration-voice';
import { advanceRun, sceneStepId, type RunStep } from './plan';
import {
  FIRST_SCENE_MAX_RETRIES,
  SCENE_MAX_RETRIES,
  withRouteRetry,
  type RouteRetryOptions,
} from './retry';
import type { RunStepServices } from './services';
import {
  commitGenerationRun,
  commitGenerationRunIn,
  confirmGenerationRunOutline,
  isGenerationRunLeaseLostError,
  readGenerationRunSteps,
  type ClaimedRun,
  type StepCommit,
  type StoredRun,
} from './store';
import type {
  GenerationRunAgentsResult,
  GenerationRunInput,
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

/** The preset a learner has before choosing agents (the settings default). */
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
  /** The run was released for the next claim to continue (an automatic confirmation). */
  | 'requeued'
  | 'paused'
  | 'completed'
  | 'ended'
  /** The lease was lost or the process is stopping: whoever claims next resumes. */
  | 'interrupted';

export interface ExecuteRunOptions {
  services: RunStepServices;
  /** Aborted when the lease is lost or the process stops. */
  signal: AbortSignal;
}

/** A failure that pauses the run at a step. */
class StepFailedError extends Error {
  constructor(
    readonly stepId: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StepFailedError';
  }
}

export async function executeGenerationRun(
  claim: ClaimedRun,
  options: ExecuteRunOptions,
): Promise<RunExecutionOutcome> {
  const { lease } = claim;
  const { services, signal } = options;
  let run: StoredRun = claim.run;
  const ownerId = run.ownerId;
  const input = run.input;
  const steps = await readGenerationRunSteps(run.id);
  const output = <T>(stepId: string) => steps.get(stepId) as T | undefined;
  const commit = async (change: StepCommit) => {
    const committed = await commitGenerationRun(lease, change);
    if (change.step) steps.set(change.step.id, change.step.output);
    // Only a commit that changes the row moves the engine's view of it: the
    // content generated ahead and the retry events commit concurrently.
    if (change.patch) run = committed;
  };
  const stepContext: StepContext = { log, signal };
  const retryOptions = (
    stepId: string,
    sceneIndex: number,
    refusalStatus: 400 | 500,
  ): RouteRetryOptions => ({
    label: `${run.id} ${stepId}`,
    maxRetries: sceneIndex === 0 ? FIRST_SCENE_MAX_RETRIES : SCENE_MAX_RETRIES,
    refusalStatus,
    sleep: services.sleep,
    signal,
    onRetry: async (event) => {
      await commit({
        events: [
          {
            type: 'step_retry',
            data: {
              step: stepId,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              reason: event.reason,
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

  // ── Scene content, possibly generated ahead ──
  const generateContent = async (sceneIndex: number): Promise<SceneContentResult> => {
    const { outlines, languageDirective, taskEngineMode } = outline();
    const stepId = sceneStepId(sceneIndex, 'content');
    const research = output<ResearchOutput>('research');
    return withRouteRetry(
      () =>
        services.sceneContent(
          ownerId,
          {
            outline: outlines[sceneIndex]!,
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
          stepContext,
        ),
      retryOptions(stepId, sceneIndex, 500),
    );
  };
  // Content generated ahead, by scene index (a holder: closures assign it).
  const ahead: { prewarm: Map<number, Promise<SceneContentResult | { failed: unknown }>> | null } =
    { prewarm: null };
  const prewarmAbort = new AbortController();
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
          const result = await generateContent(sceneIndex);
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
      { shouldContinue: () => !prewarmAbort.signal.aborted && !signal.aborted },
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

  // ── One step ──
  const runStep = async (step: RunStep): Promise<StepCommit> => {
    const stepId = step.id;
    const done = (value: unknown, extra: Partial<StepCommit> = {}): StepCommit => ({
      step: { id: stepId, output: value },
      patch: extra.patch,
      events: [{ type: 'step_completed', data: { step: stepId } }, ...(extra.events ?? [])],
    });

    switch (step.kind) {
      case 'material-analysis': {
        const pdfText = await services.analyzeMaterials(ownerId, input.materialIds, stepContext);
        return done({ pdfText } satisfies MaterialOutput);
      }

      case 'research': {
        const pdfText = output<MaterialOutput>('material-analysis')?.pdfText;
        const result = await services.research(
          ownerId,
          { query: input.requirement, ...(pdfText ? { pdfText } : {}) },
          stepContext,
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
          if ('failed' in result) throw result.failed;
          // Committed when it completed; nothing more to record.
          return {};
        }
        return done(await generateContent(step.sceneIndex));
      }

      case 'actions': {
        const index = step.sceneIndex;
        const { outlines, languageDirective } = outline();
        const content = output<SceneContentResult>(sceneStepId(index, 'content'))!;
        // The speeches of the scene before: the first scene has none; the
        // classroom starts the second from the stored first scene; each later
        // scene takes the previous scene's actions result.
        const previousSpeeches =
          index === 0
            ? []
            : index === 1
              ? speechesOf(output<NarrationOutput>(sceneStepId(0, 'narration'))!.scene)
              : (output<SceneActionsResult>(sceneStepId(index - 1, 'actions'))!.previousSpeeches ??
                []);
        const userProfile = learnerProfileText(input);
        const result = await withRouteRetry(
          () =>
            services.sceneActions(
              ownerId,
              {
                outline: content.effectiveOutline || outlines[index]!,
                allOutlines: outlines,
                // The route receives the content as JSON; so does this step.
                content: content.content as SceneActionsInput['content'],
                stageId: agents().stage.id,
                agents: agents().agents.agents,
                previousSpeeches,
                ...(userProfile ? { userProfile } : {}),
                languageDirective,
              },
              stepContext,
            ),
          retryOptions(stepId, index, 500),
        );
        return done(result);
      }

      case 'narration':
        return done(await narrateScene(step.sceneIndex, stepId));

      case 'append':
        return appendScene(step.sceneIndex, stepId);
    }
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
      result = await services.outline(
        ownerId,
        {
          requirements: runRequirements(input, research?.webSearch === true),
          ...(pdfText ? { pdfText } : {}),
          ...(research?.context ? { researchContext: research.context } : {}),
        },
        { log, signal, emit },
      );
    } finally {
      await appending;
    }
    if (appendFailure) throw appendFailure;
    const confirmed: GenerationRunOutline = {
      outlines: result.outlines,
      languageDirective: result.languageDirective,
      ...(result.courseTitle ? { courseTitle: result.courseTitle } : {}),
      taskEngineMode: result.taskEngineMode,
    };
    return {
      step: { id: stepId, output: result },
      patch: {
        state: 'awaiting_outline_confirmation',
        step: null,
        outline: confirmed,
        outlineRevision: 1,
        scenesTotal: result.outlines.length,
        releaseLease: true,
      },
      events: [
        { type: 'step_completed', data: { step: stepId } },
        { type: 'outline_ready', data: { revision: 1, outline: confirmed } },
        { type: 'state', data: { state: 'awaiting_outline_confirmation', step: null } },
      ],
    };
  };

  const resolveAgents = async (): Promise<AgentsOutput> => {
    const { outlines, languageDirective, courseTitle, taskEngineMode } = outline();
    const name = courseTitle || topicFromRequirement(input.requirement);
    let result: GenerationRunAgentsResult;
    if (input.agents.mode === 'auto') {
      try {
        const target = await services.narrationTarget(ownerId);
        const profiles = await services.agentProfiles(
          ownerId,
          {
            stageInfo: { name, description: '' },
            sceneOutlines: outlines.map((o) => ({ title: o.title, description: o.description })),
            languageDirective,
            availableAvatars: AGENT_AVATARS.map((a) => a.path),
            avatarDescriptions: AGENT_AVATARS.map((a) => ({ path: a.path, desc: a.desc })),
            availableVoices: target ? advertisedVoices(target) : [],
            narratorVoice: target ? narratorVoiceForGeneration(target, input.voice) : undefined,
          },
          stepContext,
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
        log.warn(`run ${run.id}: agent generation failed, falling back to presets:`, error);
        const presets = await services.presetAgents(ownerId, DEFAULT_PRESET_AGENT_IDS);
        result = { agents: presets, agentIds: presets.map((agent) => agent.id) };
      }
    } else {
      const presets: AgentInfo[] = await services.presetAgents(ownerId, input.agents.agentIds);
      result = { agents: presets, agentIds: presets.map((agent) => agent.id) };
    }
    const now = Date.now();
    const stage: Stage = {
      id: generateClassroomId(),
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

  const narrateScene = async (sceneIndex: number, stepId: string): Promise<NarrationOutput> => {
    const actions = output<SceneActionsResult>(sceneStepId(sceneIndex, 'actions'))!;
    const scene: Scene = structuredClone(actions.scene) as Scene;
    const target = await services.narrationTarget(ownerId);
    if (!target) return { scene };
    scene.actions = splitLongSpeechActions(scene.actions || [], target.providerId);
    const speechActions = scene.actions.filter(
      (action): action is SpeechAction => action.type === 'speech' && !!action.text,
    );
    const roster = agents().agents.generatedAgentConfigs;
    const voice = clipVoice(target, input.voice, roster);
    const { speed } = slotVoice(target, input.voice);
    const stageId = agents().stage.id;
    const narrateOne = async (action: SpeechAction) => {
      const audioId = `tts_s${scene.order}_${action.id}`;
      const assetId = await withRouteRetry(
        () =>
          services.narrateClip(
            ownerId,
            { target, stageId, text: action.text, audioId, voice: voice.voiceId, speed },
            stepContext,
          ),
        retryOptions(stepId, sceneIndex, 400),
      );
      if (assetId) action.audioId = assetId;
    };
    const concurrency = services.parallelSceneConcurrency();
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
    return { scene };
  };

  const appendScene = async (sceneIndex: number, stepId: string): Promise<StepCommit> => {
    const scene = output<NarrationOutput>(sceneStepId(sceneIndex, 'narration'))!.scene;
    const { stage } = agents();
    const events: NewGenerationRunEvent[] = [
      { type: 'step_completed', data: { step: stepId } },
      ...(sceneIndex === 0
        ? [{ type: 'course_created' as const, data: { stageId: stage.id } }]
        : []),
      {
        type: 'scene_ready',
        data: { index: sceneIndex, sceneId: scene.id, order: scene.order },
      },
    ];
    const change: StepCommit = {
      step: { id: stepId, output: { sceneId: scene.id } },
      patch: {
        scenesCompleted: sceneIndex + 1,
        ...(sceneIndex === 0 ? { stageId: stage.id } : {}),
      },
      events,
    };
    if (sceneIndex === 0) {
      // The course and the checkpoint that records it, in one transaction.
      await createRunCourse({
        ownerId,
        lease,
        stage,
        outlines: outline().outlines,
        firstScene: scene,
        inTransaction: async (tx) => {
          run = await commitGenerationRunIn(tx, lease, change);
        },
      });
      steps.set(stepId, change.step!.output);
      return {};
    }
    // A retried append rewrites the same scene id, so this is safe to repeat.
    await appendRunScene({ ownerId, lease, stageId: stage.id, scene });
    return change;
  };

  const complete = async (): Promise<void> => {
    const stageId = agents().stage.id;
    await completeRunCourse({ ownerId, lease, stageId });
    const { withTransaction } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    run = await withTransaction(async (tx) => {
      const committed = await commitGenerationRunIn(tx, lease, {
        patch: { state: 'completed', step: null, releaseLease: true },
        events: [
          { type: 'completed', data: { stageId } },
          { type: 'state', data: { state: 'completed', step: null } },
        ],
      });
      await markStageGenerationComplete(tx, stageId);
      return committed;
    });
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

  try {
    for (;;) {
      if (signal.aborted) return 'interrupted';
      const advance = advanceRun({
        state: run.state,
        runInput: input,
        completed: new Set(steps.keys()),
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
      if (advance.kind === 'complete') {
        await complete();
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
      let change: StepCommit;
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
      if (change.step || change.patch || change.events?.length) await commit(change);
      if (run.state === 'awaiting_outline_confirmation') {
        if (input.outlineReview === 'auto') {
          await confirmGenerationRunOutline(run.id, ownerId, {
            commandId: 'auto-confirm',
            outlineRevision: run.outline!.revision,
          });
          return 'requeued';
        }
        return 'waiting';
      }
    }
  } catch (error) {
    if (error instanceof RunCourseDeletedError) {
      await end(error.stageId).catch((endError) => {
        if (!isGenerationRunLeaseLostError(endError)) throw endError;
      });
      return 'ended';
    }
    if (isGenerationRunLeaseLostError(error) || signal.aborted || isAbortError(error)) {
      return 'interrupted';
    }
    if (error instanceof StepFailedError) {
      const message = error.message || 'The step failed';
      log.warn(`run ${run.id}: step ${error.stepId} failed; pausing`, error.cause);
      try {
        await commit({
          patch: {
            state: 'paused',
            step: error.stepId,
            error: { step: error.stepId, message },
            releaseLease: true,
          },
          events: [
            { type: 'step_failed', data: { step: error.stepId, message } },
            { type: 'state', data: { state: 'paused', step: error.stepId } },
          ],
        });
      } catch (pauseError) {
        if (isGenerationRunLeaseLostError(pauseError)) return 'interrupted';
        throw pauseError;
      }
      return 'paused';
    }
    throw error;
  } finally {
    prewarmAbort.abort();
    if (ahead.prewarm) await Promise.allSettled(ahead.prewarm.values());
  }
}
