import {
  proxyActivities,
  defineQuery,
  setHandler,
  executeChild,
} from '@temporalio/workflow';
import type {
  SetupResult,
  PersistResult,
  GenerateSingleSceneParams,
  PushSceneToSupabaseParams,
  GenerateMediaParams,
  GenerateTTSWithProviderParams,
  PersistClassroomParams,
  SendCompletionNotificationParams,
} from '../activities/classroom-generation.activities';
import type { InsertCourseAndGenerateTagsParams } from '../activities/course-catalog.activities';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import type { Scene } from '@/lib/types/stage';
import { TASK_QUEUE } from '../constants';
import { insertCourseAndGenerateTagsWorkflow } from './course-catalog.workflow';
import type {
  ClassroomWorkflowStatus,
  ClassroomJobStatus,
  ClassroomGenerationStep,
} from './classroom-generation.workflow';
import { getStatusQuery } from './classroom-generation.workflow';

// ---------------------------------------------------------------------------
// Activity proxies
// ---------------------------------------------------------------------------

const {
  setupAndGenerateOutlinesActivity,
  generateSingleSceneActivity,
  pushSceneToSupabaseActivity,
  generateMediaActivity,
  generateTTSWithProviderActivity,
  persistClassroomActivity,
  sendCompletionNotificationActivity,
} = proxyActivities<{
  setupAndGenerateOutlinesActivity(input: GenerateClassroomInput): Promise<SetupResult>;
  generateSingleSceneActivity(params: GenerateSingleSceneParams): Promise<Scene | null>;
  pushSceneToSupabaseActivity(params: PushSceneToSupabaseParams): Promise<void>;
  generateMediaActivity(params: GenerateMediaParams): Promise<Scene[]>;
  generateTTSWithProviderActivity(params: GenerateTTSWithProviderParams): Promise<Scene[]>;
  persistClassroomActivity(params: PersistClassroomParams): Promise<PersistResult>;
  sendCompletionNotificationActivity(params: SendCompletionNotificationParams): Promise<void>;
}>({
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '10s',
    backoffCoefficient: 2,
  },
});

// ---------------------------------------------------------------------------
// Workflow input
// ---------------------------------------------------------------------------

export interface QueuedClassroomWorkflowInput {
  input: GenerateClassroomInput;
  baseUrl: string;
  userId: string;
  userEmail?: string;
  jobId: string;
  ttsProvider?: string;
}

// ---------------------------------------------------------------------------
// Workflow — same pipeline as classroomGenerationWorkflow but:
//   • Uses an explicit TTS provider (default: fish-tts, cheaper)
//   • Sends a completion notification via sendCompletionNotificationActivity
// ---------------------------------------------------------------------------

export async function queuedClassroomGenerationWorkflow(
  args: QueuedClassroomWorkflowInput,
): Promise<PersistResult> {
  const { input, baseUrl, userId, userEmail, jobId, ttsProvider = 'fish-tts' } = args;

  let status: ClassroomJobStatus = 'running';
  let step: ClassroomGenerationStep = 'initializing';
  let progress = 5;
  let message = 'Initializing classroom generation';
  let scenesGenerated = 0;
  let totalScenes: number | undefined;
  let result: ClassroomWorkflowStatus['result'] | undefined;
  let errorMessage: string | undefined;

  setHandler(getStatusQuery, (): ClassroomWorkflowStatus => ({
    status,
    step,
    progress,
    message,
    scenesGenerated,
    totalScenes,
    result,
    error: errorMessage,
    done: status === 'succeeded' || status === 'failed',
  }));

  try {
    // ---- Step 1: Setup + outlines ----
    const setup = await setupAndGenerateOutlinesActivity(input);
    const { stage, agents, outlines, courseDescription } = setup;

    step = 'generating_outlines';
    progress = 15;
    message = `Generated ${outlines.length} scene outlines`;
    totalScenes = outlines.length;

    // ---- Step 2: Generate scenes ----
    step = 'generating_scenes';
    progress = 30;
    const scenes: Scene[] = [];

    for (const [index, outline] of outlines.entries()) {
      progress = Math.max(30 + Math.floor((index / Math.max(outlines.length, 1)) * 55), 31);
      message = `Generating scene ${index + 1}/${outlines.length}: ${outline.title}`;

      const scene = await generateSingleSceneActivity({ outline, stage, agents, input });
      if (scene) {
        scenes.push(scene);
        scenesGenerated = scenes.length;
        await pushSceneToSupabaseActivity({ stage, scenes, courseDescription });
      }

      progress = Math.min(30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 55), 85);
      message = `Generated ${scenesGenerated}/${outlines.length} scenes`;
    }

    if (scenes.length === 0) throw new Error('No scenes were generated');

    // ---- Step 3: Media generation ----
    step = 'generating_media';
    progress = 87;
    message = 'Generating media files';

    let finalScenes: Scene[] = await generateMediaActivity({
      scenes,
      outlines,
      stageId: stage.id,
      baseUrl,
      enableImageGeneration: input.enableImageGeneration,
      enableVideoGeneration: input.enableVideoGeneration,
    });

    // ---- Step 4: TTS with explicit provider (fish-tts by default) ----
    step = 'generating_tts';
    progress = 92;
    message = `Generating TTS audio (${ttsProvider})`;

    finalScenes = await generateTTSWithProviderActivity({
      scenes: finalScenes,
      stageId: stage.id,
      baseUrl,
      ttsProviderId: ttsProvider,
    });

    // ---- Step 5: Persist ----
    step = 'persisting';
    progress = 97;
    message = 'Persisting classroom data';

    const persistResult = await persistClassroomActivity({
      stage,
      scenes: finalScenes,
      courseDescription,
      baseUrl,
    });

    // ---- Step 6: Catalog tags (fire-and-forget) ----
    void executeChild(insertCourseAndGenerateTagsWorkflow, {
      workflowId: `catalog-${stage.id}`,
      taskQueue: TASK_QUEUE,
      args: [{
        stage,
        outlines,
        requirement: input.requirement,
      } satisfies InsertCourseAndGenerateTagsParams],
    });

    // ---- Step 7: Send completion notification ----
    await sendCompletionNotificationActivity({
      userId,
      userEmail,
      jobId,
      classroomId: persistResult.classroomId,
      classroomUrl: persistResult.url,
      requirementSnippet: input.requirement.substring(0, 60),
    });

    status = 'succeeded';
    step = 'completed';
    progress = 100;
    message = 'Classroom generation completed';
    scenesGenerated = finalScenes.length;
    result = {
      classroomId: persistResult.classroomId,
      url: persistResult.url,
      scenesCount: persistResult.scenesCount,
    };

    return persistResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status = 'failed';
    step = 'failed';
    message = 'Classroom generation failed';
    errorMessage = msg;
    throw err;
  }
}
