/**
 * Synchronous slide content generation — returns raw PPTElements without persisting a scene.
 * Used by the per-slide regeneration flow.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { generateSceneContentFromInput } from '@/lib/server/scene-content-generation';
import { getStorageBackend } from '@/lib/server/storage';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { SceneOutline, GeneratedSlideContent } from '@/lib/types/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';

const log = createLogger('SceneContentOnly API');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { outline, stageId, agents, themeId } = body as {
      outline: SceneOutline;
      stageId: string;
      agents?: AgentInfo[];
      themeId?: string;
    };

    if (!outline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    if (outline.type !== 'slide') {
      return apiError('INVALID_REQUEST', 400, 'Only slide-type outlines are supported');
    }

    // Load stage metadata and outlines from server storage
    const backend = getStorageBackend();
    const [stageData, savedOutlines] = await Promise.all([
      backend.loadStage(stageId),
      backend.loadOutlines(stageId),
    ]);

    if (!stageData) {
      return apiError('NOT_FOUND', 404, 'Stage not found');
    }

    const allOutlines = savedOutlines ?? [outline];
    const stageInfo = {
      name: stageData.stage.name ?? '',
      description: stageData.stage.description,
      language: stageData.stage.language,
      style: stageData.stage.style,
      themeId,
    };

    // ── Model resolution from request headers ──
    const { modelString } = await resolveModelFromHeaders(req);

    const result = await generateSceneContentFromInput({
      outline,
      allOutlines,
      stageId,
      stageInfo,
      agents,
      modelConfig: { modelString },
    });

    // Return only the slide content fields (elements + background)
    const slideContent = result.content as GeneratedSlideContent;
    return apiSuccess({
      data: {
        elements: slideContent.elements ?? [],
        background: slideContent.background,
      },
    });
  } catch (error) {
    log.error('scene-content-only failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
