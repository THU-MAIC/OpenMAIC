import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import type { CourseStore } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';

const Params = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.String(),
  viewport: Type.Optional(
    Type.Object({
      width: Type.Integer({ minimum: 64, maximum: 4096 }),
      height: Type.Integer({ minimum: 64, maximum: 4096 }),
      deviceScaleFactor: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2 })),
    }),
  ),
});

export interface ScenePreviewDeps {
  store: CourseStore;
  /** Fail-closed owner probe for the previewed stage. */
  stageAccess: (
    stageId: string,
  ) => Promise<{ kind: 'owned' | 'missing' | 'foreign' | 'tombstoned' }>;
  /** The session owner; rides the render request as the trusted client id. */
  ownerId: string;
  renderService?: ReturnType<typeof resolveRenderServiceUrl>;
  fetchPreview?: typeof proxyFetch;
}

function failure(sceneId: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: `Preview failed: ${message}` }],
    details: { sceneId },
    isError: true,
  };
}

export function buildScenePreviewTools(deps: ScenePreviewDeps): AgentTool<never, never>[] {
  const service = deps.renderService ?? resolveRenderServiceUrl();
  if ('error' in service) return [];
  return [
    {
      name: 'render_scene_preview',
      label: 'Render page preview',
      description: 'Render one persisted page to PNG for visual inspection.',
      parameters: Params,
      async execute(_callId, params, signal) {
        if (signal?.aborted) return failure(params.sceneId, 'operation aborted');
        const access = await deps.stageAccess(params.stageId);
        if (signal?.aborted) return failure(params.sceneId, 'operation aborted');
        if (access.kind !== 'owned') {
          return failure(params.sceneId, 'course not found or not owned by this session user');
        }
        const doc = await deps.store.loadDocument(params.stageId);
        const scene = doc?.scenes.find((item) => item.id === params.sceneId);
        if (!doc || !scene) return failure(params.sceneId, 'page not found in this session course');
        const viewport = {
          width: params.viewport?.width ?? 1280,
          height: params.viewport?.height ?? 720,
          deviceScaleFactor: params.viewport?.deviceScaleFactor ?? 1,
        };
        try {
          const response = await (deps.fetchPreview ?? proxyFetch)(`${service.url}/preview`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-openmaic-client': deps.ownerId,
            },
            body: JSON.stringify({
              version: 1,
              scene,
              stage: { id: doc.stage.id, name: doc.stage.name },
              viewport,
            }),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
              : AbortSignal.timeout(25_000),
          });
          if (!response.ok)
            return failure(scene.id, `render service returned HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) return failure(scene.id, 'render service returned an empty image');
          return {
            content: [
              { type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' },
            ],
            details: { sceneId: scene.id, viewport, bytes: bytes.length },
          };
        } catch (error) {
          if (signal?.aborted) return failure(scene.id, 'operation aborted');
          return failure(scene.id, error instanceof Error ? error.message : 'unknown render error');
        }
      },
    } as AgentTool<typeof Params>,
  ] as unknown as AgentTool<never, never>[];
}

export const RENDER_SCENE_PREVIEW_TOOL_NAME = 'render_scene_preview' as const;
