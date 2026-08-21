import { expect } from 'vitest';
import type { StageAssetDocument } from '@/lib/media/collect-stage-asset-refs';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';

export interface AssetOwnershipSnapshot {
  readonly document: StageAssetDocument;
  readonly mediaRowIds: ReadonlySet<string>;
  readonly audioRowIds: ReadonlySet<string>;
  readonly poolHas: (ref: string) => Promise<boolean>;
}

/** Assert that every allocated document ref owns both compatibility and pool storage. */
export async function expectDocumentAssetOwnership({
  document,
  mediaRowIds,
  audioRowIds,
  poolHas,
}: AssetOwnershipSnapshot): Promise<void> {
  const refs = collectStageAssetRefs(document, { mediaRows: [], audioRows: [] });
  const allocated = [...refs.document].filter(
    (ref) =>
      /^ast_[\w-]+$/i.test(ref) &&
      !isConcreteMediaAddress(ref) &&
      !isGeneratedMediaPlaceholder(ref),
  );

  for (const ref of allocated) {
    const isAudio = refs.speechAudioId.has(ref) || refs.slideAudioSrc.has(ref);
    const compatibilityId = isAudio ? ref : `${document.stage.id}:${ref}`;
    expect(
      isAudio ? audioRowIds.has(compatibilityId) : mediaRowIds.has(compatibilityId),
      `${ref} is document-referenced but lacks its compatibility row`,
    ).toBe(true);
    await expect(
      poolHas(ref),
      `${ref} is document-referenced but lacks its pool entry`,
    ).resolves.toBe(true);
  }
}
