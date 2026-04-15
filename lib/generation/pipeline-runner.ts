/**
 * Top-level pipeline orchestration.
 * Creates sessions and runs the full generation pipeline.
 */

import { nanoid } from 'nanoid';
import type { UserRequirements, GenerationSession } from '@/lib/types/generation';
import type { StageStore } from '@/lib/api/stage-api';
import { generateSceneOutlinesFromRequirements } from './outline-generator';
import { generateFullScenes } from './scene-generator';
import type { AICallFn, GenerationResult, GenerationCallbacks } from './pipeline-types';

export function createGenerationSession(requirements: UserRequirements): GenerationSession {
  return {
    id: nanoid(),
    requirements,
    progress: {
      currentStage: 1,
      overallProgress: 0,
      stageProgress: 0,
      statusMessage: '...',
      scenesGenerated: 0,
      totalScenes: 0,
    },
    startedAt: new Date(),
  };
}

// For full testing
export async function runGenerationPipeline(
  session: GenerationSession,
  store: StageStore,
  aiCall: AICallFn,
  callbacks?: GenerationCallbacks,
): Promise<GenerationResult<GenerationSession>> {
  try {
    // Stage 1: Generate Scene Outlines from Requirements
    callbacks?.onProgress?.({
      ...session.progress,
      currentStage: 1,
      overallProgress: 5,
      statusMessage: '，...',
    });

    const outlinesResult = await generateSceneOutlinesFromRequirements(
      session.requirements,
      undefined, // No PDF text in this flow
      undefined, // No PDF images in this flow
      aiCall,
      callbacks,
    );
    if (!outlinesResult.success || !outlinesResult.data) {
      throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
    }
    session.sceneOutlines = outlinesResult.data;
    callbacks?.onStageComplete?.(1, session.sceneOutlines);

    // Stage 2: Generate Full Scenes
    callbacks?.onProgress?.({
      ...session.progress,
      currentStage: 2,
      overallProgress: 50,
      statusMessage: '...',
      totalScenes: session.sceneOutlines.length,
    });

    const scenesResult = await generateFullScenes(session.sceneOutlines, store, aiCall, callbacks);
    if (!scenesResult.success) {
      throw new Error(scenesResult.error || 'Failed to generate scenes');
    }
    callbacks?.onStageComplete?.(2, scenesResult.data);

    // Complete
    session.completedAt = new Date();
    session.progress = {
      currentStage: 2,
      overallProgress: 100,
      stageProgress: 100,
      statusMessage: '！',
      scenesGenerated: scenesResult.data?.length || 0,
      totalScenes: session.sceneOutlines.length,
    };

    return { success: true, data: session };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    callbacks?.onError?.(errorMessage);
    session.progress.errors = [...(session.progress.errors || []), errorMessage];
    return { success: false, error: errorMessage };
  }
}
