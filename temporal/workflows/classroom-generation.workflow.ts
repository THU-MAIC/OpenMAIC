import {
  proxyActivities,
  defineQuery,
  setHandler,
  executeChild,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  SetupResult,
  PersistResult,
  GenerateSingleSceneParams,
  PushSceneToSupabaseParams,
  GenerateMediaParams,
  GenerateTTSParams,
  PersistClassroomParams,
} from '../activities/classroom-generation.activities';
import type {
  InsertCourseAndGenerateTagsParams,
} from '../activities/course-catalog.activities';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { TASK_QUEUE } from '../constants';
import {
  insertCourseAndGenerateTagsWorkflow,
} from './course-catalog.workflow';

// ---------------------------------------------------------------------------
// Activity proxies
// ---------------------------------------------------------------------------

const {
  setupAndGenerateOutlinesActivity,
  generateSingleSceneActivity,
  pushSceneToSupabaseActivity,
  generateMediaActivity,
  generateTTSActivity,
  persistClassroomActivity,
} = proxyActivities<{
  setupAndGenerateOutlinesActivity(input: GenerateClassroomInput): Promise<SetupResult>;
  generateSingleSceneActivity(params: GenerateSingleSceneParams): Promise<Scene | null>;
  pushSceneToSupabaseActivity(params: PushSceneToSupabaseParams): Promise<void>;
  generateMediaActivity(params: GenerateMediaParams): Promise<Scene[]>;
  generateTTSActivity(params: GenerateTTSParams): Promise<Scene[]>;
  persistClassroomActivity(params: PersistClassroomParams): Promise<PersistResult>;
}>({
  // Individual scene generation can take a while; use a generous timeout
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '10s',
    backoffCoefficient: 2,
  },
});

// ---------------------------------------------------------------------------
// Status query type — mirrors the polling API response
// ---------------------------------------------------------------------------

export type ClassroomJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed'
  | 'queued'
  | 'failed';

export interface ClassroomWorkflowStatus {
  status: ClassroomJobStatus;
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
  done: boolean;
}

export const getStatusQuery = defineQuery<ClassroomWorkflowStatus>('getStatus');

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface ClassroomGenerationWorkflowInput {
  input: GenerateClassroomInput;
  baseUrl: string;
}

export async function classroomGenerationWorkflow(
  args: ClassroomGenerationWorkflowInput,
): Promise<PersistResult> {
  const { input, baseUrl } = args;

  // Mutable status state exposed via query
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
    // ---- Step 1: Initialise + optionally generate agents, web search, and outlines ----
    step = 'initializing';
    progress = 5;
    message = 'Initializing classroom generation';

    const setup = await setupAndGenerateOutlinesActivity(input);
    const { stage, agents, outlines, courseDescription } = setup;

    step = 'generating_outlines';
    progress = 15;
    message = `Generated ${outlines.length} scene outlines`;
    totalScenes = outlines.length;

    // ---- Step 2: Generate all scenes in parallel ----
    step = 'generating_scenes';
    progress = 30;
    message = `Generating ${outlines.length} scenes in parallel`;

    let completed = 0;
    const sceneResults = await Promise.all(
      outlines.map(async (outline) => {
        const scene = await generateSingleSceneActivity({ outline, stage, agents, input });
        if (scene) {
          completed++;
          scenesGenerated = completed;
          progress = 30 + Math.floor((completed / Math.max(outlines.length, 1)) * 55);
          message = `Generated ${completed}/${outlines.length} scenes`;
        }
        return scene;
      }),
    );

    const scenes: Scene[] = sceneResults.filter((s): s is Scene => s !== null);

    if (scenes.length === 0) {
      throw new Error('No scenes were generated');
    }

    // Single bulk Supabase sync after all scenes are ready
    progress = 85;
    message = 'Syncing scenes to cloud';
    await pushSceneToSupabaseActivity({ stage, scenes, courseDescription });

    // ---- Step 3: Media generation (optional) ----
    let finalScenes: Scene[] = scenes;

    // if (input.enableImageGeneration || input.enableVideoGeneration) {
    step = 'generating_media';
    progress = 87;
    message = 'Generating media files';

    finalScenes = await generateMediaActivity({
      scenes: finalScenes,
      outlines,
      stageId: stage.id,
      baseUrl,
      enableImageGeneration: input.enableImageGeneration,
      enableVideoGeneration: input.enableVideoGeneration,
    });
    // }

    // ---- Step 4: TTS generation (optional) ----
    // if (input.enableTTS) {
    step = 'generating_tts';
    progress = 92;
    message = 'Generating TTS audio';

    finalScenes = await generateTTSActivity({
      scenes: finalScenes,
      stageId: stage.id,
      baseUrl,
    });
    // }

    // ---- Step 5: Final Supabase sync + persist ----
    step = 'persisting';
    progress = 97;
    message = 'Persisting classroom data';

    const persistResult = await persistClassroomActivity({
      stage,
      scenes: finalScenes,
      courseDescription,
      baseUrl,
    });

    // ---- Step 6: Catalog tags (child workflow, non-blocking) ----
    const catalogParams: InsertCourseAndGenerateTagsParams = {
      stage,
      outlines,
      requirement: input.requirement,
    };

    // Fire-and-forget child workflow — we don't await its completion
    void executeChild(insertCourseAndGenerateTagsWorkflow, {
      workflowId: `catalog-${stage.id}`,
      taskQueue: TASK_QUEUE,
      args: [catalogParams],
    });

    // Mark done
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
