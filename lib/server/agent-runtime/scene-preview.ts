import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import type { Scene } from '@/lib/types/stage';
import type { CourseStore } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';

const Params = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.String({
    description:
      'The page to render: its scene id or its 1-based page order, the same selectors read_stage and patch_stage address under /scenes/.',
  }),
  viewport: Type.Optional(
    Type.Object({
      width: Type.Integer({ minimum: 64, maximum: 4096 }),
      height: Type.Integer({ minimum: 64, maximum: 4096 }),
    }),
  ),
});

/**
 * The preview renders at device scale 1. The image is for the agent's own
 * visual check, where 1 is enough, and render services on a low-memory profile
 * refuse anything higher.
 */
const PREVIEW_DEVICE_SCALE_FACTOR = 1;

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

/**
 * The scene a selector names: an exact scene id, a 1-based page order, or
 * either written as a read_stage path (`/scenes/<selector>`).
 */
export function resolvePreviewScene(scenes: readonly Scene[], selector: string): Scene | undefined {
  const token = selector.trim().replace(/^\/?scenes\//, '');
  const byId = scenes.find((scene) => scene.id === token);
  if (byId) return byId;
  if (/^[1-9]\d*$/.test(token)) return scenes.find((scene) => scene.order === Number(token));
  return undefined;
}

function pageList(scenes: readonly Scene[]): string {
  return [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => `${scene.order}=${scene.id}`)
    .join(', ');
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
        if (!doc) return failure(params.sceneId, 'course has no persisted pages yet');
        const scene = resolvePreviewScene(doc.scenes, params.sceneId);
        if (!scene) {
          return failure(
            params.sceneId,
            doc.scenes.length
              ? `no page matches ${JSON.stringify(params.sceneId)}. Pass a scene id or a 1-based page order; pages (order=id): ${pageList(doc.scenes)}.`
              : 'the course has no pages yet',
          );
        }
        const viewport = {
          width: params.viewport?.width ?? 1280,
          height: params.viewport?.height ?? 720,
          deviceScaleFactor: PREVIEW_DEVICE_SCALE_FACTOR,
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
            details: { sceneId: scene.id, order: scene.order, viewport, bytes: bytes.length },
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
