import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { getSessionMaterial, resolveSessionMaterialRawAsset } from './session-materials';

const Params = Type.Object({
  materialId: Type.String({ description: 'The session material id to promote.' }),
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
});

export interface MaterialMediaDeps {
  sessionId: string;
  getMaterial?: typeof getSessionMaterial;
  readRawBytes?: typeof resolveSessionMaterialRawAsset;
}

export function buildMaterialMediaTool(deps: MaterialMediaDeps): AgentTool<never, never> {
  return {
    name: 'use_material_media',
    label: 'Use material media',
    description:
      'Copy one session image, video, or audio material into the target stage media path and return its renderable src.',
    parameters: Params,
    async execute(_callId: string, params: Static<typeof Params>, signal?: AbortSignal) {
      const material = await (deps.getMaterial ?? getSessionMaterial)(
        deps.sessionId,
        params.materialId,
      );
      if (!material?.rawAssetId) {
        return {
          content: [{ type: 'text', text: 'Media material not found or has no media bytes.' }],
          details: { materialId: params.materialId },
          isError: true,
        };
      }
      const source = await (deps.readRawBytes ?? resolveSessionMaterialRawAsset)(
        deps.sessionId,
        material.rawAssetId,
      );
      if (!source) {
        return {
          content: [{ type: 'text', text: 'Media bytes are unavailable.' }],
          details: { materialId: material.id },
          isError: true,
        };
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!/^(image|video|audio)\//.test(source.mime)) {
        return {
          content: [
            { type: 'text', text: 'Only image, video, or audio materials can be promoted.' },
          ],
          details: { materialId: material.id, mimeType: source.mime },
          isError: true,
        };
      }
      const src = await persistClassroomMediaBytes({
        stageId: params.stageId,
        bytes: source.bytes,
        mime: source.mime,
        prefix: `material-${material.id}`,
        signal,
      });
      return {
        content: [{ type: 'text', text: `Use src "${src}" for the slide media element.` }],
        details: {
          materialId: material.id,
          src,
          mimeType: source.mime,
          bytes: source.bytes.byteLength,
        },
      };
    },
  } as unknown as AgentTool<never, never>;
}

export const MATERIAL_MEDIA_TOOL_NAME = 'use_material_media' as const;
