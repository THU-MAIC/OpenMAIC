import { fetchStageMeta, type StageMetaResult } from '@/lib/classroom/stage-meta-client';
import { classroomPageUrl } from '@/lib/classroom/scene-deep-link';
import type { OnlineClassroom } from './pptx-scene-placeholders';

/**
 * Where an exported classroom can be opened online: the classroom page on
 * `origin` (the deployment the export runs on, unless a host overrides it),
 * and whether it is public. A classroom whose metadata cannot be read counts
 * as not public, so the deck asks the owner to publish it rather than
 * promising that anyone can open it.
 */
export async function resolveOnlineClassroom(
  stageId: string,
  {
    origin,
    fetchMeta = fetchStageMeta,
  }: { origin: string; fetchMeta?: (stageId: string) => Promise<StageMetaResult> },
): Promise<OnlineClassroom> {
  const meta = await fetchMeta(stageId);
  return {
    classroomUrl: classroomPageUrl(origin, stageId),
    isPublic: meta.outcome === 'found' && meta.meta.isPublic,
  };
}
