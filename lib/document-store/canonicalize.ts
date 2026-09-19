import type { StageOutlinesRecord, StageRecord } from '@/lib/utils/database';
import type { AppScene } from '@/lib/types/stage';

import type { AppDocumentOutline, AppStage } from './persistence-types';

/** Separate device playback position from canonical document metadata. */
export function canonicalizeLegacyStage<T extends StageRecord>(
  record: T,
): { stage: AppStage & Omit<T, 'currentSceneId'>; currentSceneId: T['currentSceneId'] } {
  const { currentSceneId, ...stage } = record;
  return { stage, currentSceneId };
}

/** Normalize legacy scene aliases without interpreting app-owned payloads. */
export function canonicalizeLegacyScene(record: object): AppScene {
  const source = record as Record<string, unknown>;
  const { whiteboard, ...canonical } = source;
  if (!Object.prototype.hasOwnProperty.call(canonical, 'whiteboards') && whiteboard !== undefined) {
    canonical.whiteboards = whiteboard;
  }
  const content = canonical.content as { type: AppScene['type'] };
  return { ...canonical, type: content.type } as AppScene;
}

/** Remove the legacy table key from the opaque document-outline envelope. */
export function canonicalizeLegacyOutline(record: StageOutlinesRecord): AppDocumentOutline {
  const { stageId: _stageId, ...outline } = record;
  return outline;
}
