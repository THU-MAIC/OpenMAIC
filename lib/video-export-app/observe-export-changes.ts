import Dexie, { type ObservabilitySet } from 'dexie';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { db } from '@/lib/utils/database';
import { observeAssetReplacements } from '@/lib/media/asset-replacement-events';
import i18n from '@/lib/i18n/config';

/** Invalidate an export snapshot without rereading or hashing its asset bytes. */
export function observeExportChanges(invalidate: () => void): () => void {
  const stopStage = useStageStore.subscribe((state, previous) => {
    if (state.stage !== previous.stage || state.scenes !== previous.scenes) invalidate();
  });
  const stopMedia = useMediaGenerationStore.subscribe((state, previous) => {
    if (state.tasks !== previous.tasks) invalidate();
  });
  // Narration/media can be replaced under the same id, without a scene edit.
  // Dexie fires this after commit, including writes from another tab. Table-
  // level invalidation deliberately favors a recompile over stale asset bytes.
  const prefixes = ['audioFiles', 'mediaFiles'].map((table) => `idb://${db.name}/${table}/`);
  const onStorageMutated = (parts: ObservabilitySet) => {
    if (Object.keys(parts).some((part) => prefixes.some((prefix) => part.startsWith(prefix)))) {
      invalidate();
    }
  };
  Dexie.on('storagemutated', onStorageMutated);
  const stopReplacements = observeAssetReplacements(invalidate);
  i18n.on('languageChanged', invalidate);
  return () => {
    stopStage();
    stopMedia();
    Dexie.on('storagemutated').unsubscribe(onStorageMutated);
    stopReplacements();
    i18n.off('languageChanged', invalidate);
  };
}
