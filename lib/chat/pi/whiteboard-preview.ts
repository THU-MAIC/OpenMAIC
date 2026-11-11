import type { ImageContent } from '@earendil-works/pi-ai';
import { createLogger } from '@/lib/logger';
import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';
import { prepareScenePreview } from '@/lib/server/agent-runtime/scene-preview-content';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import type { Scene } from '@/lib/types/stage';
import type { FoldedWhiteboardRuntimeState } from '@/lib/whiteboard/runtime/types';
import { normalizeWhiteboardViewportRatio } from '@/lib/whiteboard/viewport';

const log = createLogger('WhiteboardPreview');

type PreviewResult = { image: ImageContent; bytes: number; notes: string[] };

export type WhiteboardPreview = (
  state: FoldedWhiteboardRuntimeState,
  signal?: AbortSignal,
) => Promise<PreviewResult | undefined>;

/** One chat request owns this cache and failure state, shared by Director and Children. */
export function createWhiteboardPreview(
  ownerId: string,
  stageId: string,
): WhiteboardPreview | undefined {
  const service = resolveRenderServiceUrl();
  if ('error' in service) return undefined;
  let failed = false;
  let cached: { key: string; result: Promise<PreviewResult | undefined> } | undefined;
  const render = async (
    state: FoldedWhiteboardRuntimeState,
    signal?: AbortSignal,
  ): Promise<PreviewResult | undefined> => {
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Preview deadline exceeded', 'TimeoutError')),
      5_000,
    );
    const previewSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
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
    } catch (error) {
      cached = undefined;
      // A Child may exhaust its tool budget while the enclosing chat continues.
      // Its cancellation must not disable previews for subsequent callers.
      if (signal?.aborted && !deadline.signal.aborted) signal.throwIfAborted();
      failed = true;
      // Only fixed categories: exception text and names may contain private URLs.
      const category =
        deadline.signal.aborted || (error instanceof Error && error.name === 'TimeoutError')
          ? 'timeout'
          : error instanceof Error && error.name === 'AbortError'
            ? 'aborted'
            : error instanceof Error && /^Preview HTTP [1-5][0-9]{2}$/.test(error.message)
              ? 'http_error'
              : 'render_failed';
      if (!signal?.aborted) {
        log.warn({
          event: 'whiteboard_preview_failed',
          category,
          durationMs: performance.now() - started,
        });
      }
      signal?.throwIfAborted();
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  return async (state, signal) => {
    signal?.throwIfAborted();
    if (failed) return undefined;
    if (state.lastSeq === null || !state.whiteboard?.elements.length) {
      cached = undefined;
      return undefined;
    }
    const key = JSON.stringify([stageId, state.sessionId, state.whiteboard.id, state.lastSeq]);
    if (cached?.key !== key) cached = { key, result: render(state, signal) };
    const result = await cached.result;
    signal?.throwIfAborted();
    // A concurrent failure also disables observations for the rest of this request.
    return failed ? undefined : result;
  };
}
