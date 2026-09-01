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

interface PreviewLayoutDiagnostics {
  version: 1;
  viewport: { width: number; height: number };
  pass: boolean;
  document: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  issues: Array<{ code: string; selector: string }>;
  truncated: boolean;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function decodeLayoutDiagnostics(
  response: Response,
  expectedViewport: { width: number; height: number },
): PreviewLayoutDiagnostics | undefined {
  const encoded = response.headers.get('x-openmaic-layout-diagnostics');
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const viewport = candidate.viewport;
    const document = candidate.document;
    const issues = candidate.issues;
    if (
      candidate.version !== 1 ||
      typeof candidate.pass !== 'boolean' ||
      typeof candidate.truncated !== 'boolean' ||
      typeof viewport !== 'object' ||
      viewport === null ||
      (viewport as { width?: unknown }).width !== expectedViewport.width ||
      (viewport as { height?: unknown }).height !== expectedViewport.height ||
      typeof document !== 'object' ||
      document === null ||
      !isFiniteNonNegative((document as { scrollWidth?: unknown }).scrollWidth) ||
      !isFiniteNonNegative((document as { scrollHeight?: unknown }).scrollHeight) ||
      !isFiniteNonNegative((document as { clientWidth?: unknown }).clientWidth) ||
      !isFiniteNonNegative((document as { clientHeight?: unknown }).clientHeight) ||
      !Array.isArray(issues) ||
      !issues.every(
        (issue) =>
          typeof issue === 'object' &&
          issue !== null &&
          typeof (issue as { code?: unknown }).code === 'string' &&
          typeof (issue as { selector?: unknown }).selector === 'string',
      ) ||
      candidate.pass !== (issues.length === 0 && candidate.truncated === false)
    ) {
      return undefined;
    }
    return parsed as PreviewLayoutDiagnostics;
  } catch {
    return undefined;
  }
}

export function buildScenePreviewTools(deps: ScenePreviewDeps): AgentTool<never, never>[] {
  const service = deps.renderService ?? resolveRenderServiceUrl();
  if ('error' in service) return [];
  return [
    {
      name: 'render_scene_preview',
      label: 'Render page preview',
      description:
        'Render one persisted page to PNG with machine-readable layout diagnostics. Check 1280x720, 768x720, and 390x844 before accepting a generated page.',
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
          const diagnostics = decodeLayoutDiagnostics(response, viewport);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) return failure(scene.id, 'render service returned an empty image');
          const qualityStatus = diagnostics ? (diagnostics.pass ? 'pass' : 'fail') : 'unverified';
          const qualityFailed = qualityStatus !== 'pass';
          return {
            content: [
              {
                type: 'text' as const,
                text: diagnostics
                  ? `Layout diagnostics: ${JSON.stringify(diagnostics)}`
                  : 'Preview quality check failed: diagnostics unavailable; repair cannot be verified.',
              },
              { type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' },
            ],
            details: {
              sceneId: scene.id,
              viewport,
              bytes: bytes.length,
              qualityStatus,
              diagnostics,
            },
            ...(qualityFailed ? { isError: true } : {}),
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
