import { fetchStageMeta, type StageMetaResult } from '@/lib/classroom/stage-meta-client';
import { classroomPageUrl } from '@/lib/classroom/scene-deep-link';
import type { Scene } from '@/lib/types/stage';
import { pptxDeckScenes, type OnlineClassroom } from './pptx-scene-placeholders';

/** How long the export waits for the classroom's public status. */
export const STAGE_META_TIMEOUT_MS = 3000;

type FetchMeta = (stageId: string, fetchImpl?: typeof globalThis.fetch) => Promise<StageMetaResult>;

/**
 * Where an exported classroom can be opened online: the classroom page on
 * `origin` (the deployment the export runs on, unless a host overrides it),
 * and whether it is public.
 *
 * The status lookup is bounded: after `timeoutMs` the request is aborted and
 * the classroom counts as not public, as it does when the metadata cannot be
 * read. The deck then asks the owner to publish it rather than promising that
 * anyone can open it, and a stalled request never blocks the export.
 */
export async function resolveOnlineClassroom(
  stageId: string,
  {
    origin,
    fetchMeta = fetchStageMeta,
    timeoutMs = STAGE_META_TIMEOUT_MS,
  }: { origin: string; fetchMeta?: FetchMeta; timeoutMs?: number },
): Promise<OnlineClassroom> {
  const controller = new AbortController();
  const fetchWithAbort: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, { ...init, signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<StageMetaResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'unavailable' });
    }, timeoutMs);
  });

  try {
    const meta = await Promise.race([fetchMeta(stageId, fetchWithAbort), timedOut]);
    return {
      classroomUrl: classroomPageUrl(origin, stageId),
      isPublic: meta.outcome === 'found' && meta.meta.isPublic,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The online classroom for a lesson's export, or undefined when no placeholder
 * slide would link to it (a slide-only or PBL-only lesson, or no stage id).
 * In that case nothing is requested, so such exports never wait on the
 * network.
 */
export async function resolveOnlineClassroomForScenes(
  scenes: readonly Scene[],
  stageId: string | undefined,
  options: Parameters<typeof resolveOnlineClassroom>[1],
): Promise<OnlineClassroom | undefined> {
  if (!stageId) return undefined;
  const hasPlaceholders = pptxDeckScenes(scenes).some((scene) => scene.content.type !== 'slide');
  if (!hasPlaceholders) return undefined;
  return resolveOnlineClassroom(stageId, options);
}
