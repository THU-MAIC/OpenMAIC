import {
  enumerateAssetManifest,
  type AssetKind,
  type AssetManifest,
  type AssetManifestMetadata,
} from '@openmaic/dsl';
import type { Scene, Stage } from '@/lib/types/stage';
import { db, mediaFileKey, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';

/**
 * The stage document's asset manifest with the metadata the compatibility
 * rows carry, ready for export paths to consume.
 *
 * The enumeration itself is the pure dsl one: the manifest is exactly the set
 * of references the document touches, so a media/audio row nothing references
 * (an orphan left behind by an edit or a failed regeneration) can no longer
 * ride along into an archive. These row reads enrich the manifest metadata.
 * At the classroom ZIP call site, media collection reads the compatibility
 * record again and supplies its blob to the shared resolver as the legacy
 * fallback after a pool miss; PPTX and video resolve bytes through their own
 * accurately documented compatibility-row paths.
 */
export async function buildStageAssetManifest(
  stage: Pick<Stage, 'whiteboard' | 'videoManifest'>,
  scenes: readonly Scene[],
  stageId: string,
  options: { readonly includeStageWhiteboard?: boolean } = {},
): Promise<AssetManifest> {
  const manifestStage =
    options.includeStageWhiteboard === false ? { ...stage, whiteboard: undefined } : stage;
  const skeleton = enumerateAssetManifest({ stage: manifestStage, scenes });

  const mediaRows = new Map<string, MediaFileRecord>();
  const audioRows = new Map<string, AudioFileRecord>();
  await Promise.all(
    skeleton.entries.map(async (entry) => {
      if (entry.kind === 'audio') {
        const row = await db.audioFiles.get(entry.ref).catch(() => undefined);
        if (row) audioRows.set(entry.ref, row);
      } else {
        const row = await db.mediaFiles
          .get(mediaFileKey(stageId, entry.ref))
          .catch(() => undefined);
        if (row) mediaRows.set(entry.ref, row);
      }
    }),
  );

  const metadata = (ref: string, kind: AssetKind): AssetManifestMetadata | undefined => {
    if (kind === 'audio') {
      const row = audioRows.get(ref);
      if (!row) return undefined;
      return {
        byteSize: row.blob?.size || undefined,
        mimeType: row.blob?.type || undefined,
        durationSeconds: row.duration,
        voice: row.voice,
      };
    }
    const row = mediaRows.get(ref);
    if (!row) return undefined;
    return {
      byteSize: row.size,
      mimeType: row.mimeType || undefined,
      prompt: row.prompt || undefined,
    };
  };

  return enumerateAssetManifest({ stage: manifestStage, scenes }, { metadata });
}
