import type { ImageContent } from '@earendil-works/pi-ai';
import { agentToolBudgetRemainingMs } from '@/lib/agent/runtime/tool-timeout';
import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';
import { prepareScenePreview } from '@/lib/server/agent-runtime/scene-preview-content';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import type { Scene } from '@/lib/types/stage';
import type { FoldedWhiteboardRuntimeState } from '@/lib/whiteboard/runtime/types';
import { normalizeWhiteboardViewportRatio } from '@/lib/whiteboard/viewport';

export type WhiteboardPreview = (
  state: FoldedWhiteboardRuntimeState,
  signal?: AbortSignal,
) => Promise<{ image: ImageContent; bytes: number; notes: string[] }>;

/** Adapt a committed snapshot to the existing scene-preview protocol. */
export function createWhiteboardPreview(
  ownerId: string,
  stageId: string,
): WhiteboardPreview | undefined {
  const service = resolveRenderServiceUrl();
  if ('error' in service) return undefined;
  return async (state, signal) => {
    // Leave time to return the successful write receipt before the tool deadline.
    const remaining = agentToolBudgetRemainingMs(signal);
    const timeoutMs = Math.min(25_000, remaining === undefined ? 25_000 : remaining - 250);
    if (timeoutMs <= 0) throw new Error('Insufficient preview budget');
    const deadline = AbortSignal.timeout(Math.floor(timeoutMs));
    const previewSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    previewSignal.throwIfAborted();
    const board = state.whiteboard;
    const width = board?.viewportSize ?? 1000;
    const ratio = normalizeWhiteboardViewportRatio(board?.viewportRatio ?? 0.5625);
    const scene: Scene = {
      id: board?.id ?? 'whiteboard-preview',
      stageId,
      title: 'Whiteboard',
      order: 1,
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: board?.id ?? 'whiteboard-preview',
          viewportSize: width,
          viewportRatio: ratio,
          elements: board?.elements ?? [],
          // Match the whiteboard's white surface, including an empty cleared board.
          background: { type: 'solid', color: '#ffffff' },
          theme: {
            backgroundColor: '#ffffff',
            themeColors: [],
            fontColor: '#333333',
            fontName: 'Microsoft YaHei',
          },
        },
      },
    };
    const prepared = await prepareScenePreview(scene, {
      readAsset: (assetId, maxBytes) =>
        resolveOwnedAsset(assetId, ownerId, process.env.DATABASE_URL ?? '', maxBytes),
      signal: previewSignal,
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    previewSignal.throwIfAborted();
    // Preserve the whole logical board while respecting the existing preview viewport limits.
    const pixelWidth = Math.max(160, Math.min(4096, Math.round(width)));
    const response = await proxyFetch(`${service.url}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-client': ownerId },
      body: JSON.stringify({
        version: 1,
        scene: prepared.scene,
        stage: { id: stageId, name: 'Whiteboard' },
        viewport: {
          width: pixelWidth,
          height: Math.round(pixelWidth * ratio),
          deviceScaleFactor: 1,
        },
      }),
      signal: previewSignal,
    });
    if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    previewSignal.throwIfAborted();
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Preview did not return a PNG');
    }
    return {
      image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
      bytes: bytes.length,
      notes: prepared.notes,
    };
  };
}
