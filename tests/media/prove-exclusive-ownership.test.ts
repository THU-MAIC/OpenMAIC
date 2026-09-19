import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  listDocuments: vi.fn(),
  stageState: { stage: null, scenes: [] } as {
    stage: Record<string, unknown> | null;
    scenes: unknown[];
  },
  probeStageRealmPresence: vi.fn(),
  serverBacked: false,
}));

vi.mock('@/lib/media/asset-pool-config', () => ({
  isAssetPoolServerBacked: () => mocks.serverBacked,
}));

vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({
    loadDocument: mocks.loadDocument,
    listDocuments: mocks.listDocuments,
  }),
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => mocks.stageState },
}));

vi.mock('@/lib/media/stage-realm-presence', () => ({
  probeStageRealmPresence: mocks.probeStageRealmPresence,
}));

import { proveExclusiveAssetOwnership } from '@/lib/media/collect-stage-asset-refs';

const ASSET = 'ast_shared_candidate';

/** One slide holding the asset once. */
function documentWithOneOwner(stageId: string) {
  return {
    stage: { id: stageId },
    scenes: [
      {
        id: `${stageId}-scene`,
        type: 'slide',
        order: 1,
        content: {
          type: 'slide',
          canvas: {
            id: `${stageId}-slide`,
            elements: [{ id: 'image-1', type: 'image', src: ASSET }],
          },
        },
      },
    ],
  };
}

describe('exclusive asset ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocument.mockResolvedValue(documentWithOneOwner('stage-1'));
    mocks.listDocuments.mockResolvedValue([{ id: 'stage-1' }]);
    mocks.stageState = { stage: null, scenes: [] };
    mocks.probeStageRealmPresence.mockResolvedValue('absent');
    mocks.serverBacked = false;
  });

  it('is exclusive with a single owner and no peer realm', async () => {
    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(true);
  });

  it('is never exclusive in server mode even when every browser-local signal is exclusive', async () => {
    mocks.serverBacked = true;

    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(false);
  });

  /**
   * A peer's unflushed edits are unobservable, so its mere presence forces the
   * fork path rather than a global mutation decided from state we cannot see.
   */
  it('is not exclusive while another realm has the stage open', async () => {
    mocks.probeStageRealmPresence.mockResolvedValue('present');

    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(false);
    expect(mocks.probeStageRealmPresence).toHaveBeenCalledWith('stage-1');
  });

  it('is not exclusive when another persisted document references the asset', async () => {
    mocks.listDocuments.mockResolvedValue([{ id: 'stage-1' }, { id: 'stage-2' }]);
    mocks.loadDocument.mockImplementation(async (id: string) =>
      documentWithOneOwner(id === 'stage-2' ? 'stage-2' : 'stage-1'),
    );

    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(false);
  });

  it('is not exclusive when the live snapshot holds a second unflushed owner', async () => {
    const live = documentWithOneOwner('stage-1');
    const copy = structuredClone(live.scenes[0]);
    copy.id = 'scene-copy';
    copy.content.canvas.id = 'slide-copy';
    copy.content.canvas.elements[0].id = 'image-copy';
    live.scenes.push(copy);
    mocks.stageState = { stage: live.stage, scenes: live.scenes };

    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(false);
  });

  it('is not exclusive when duplicate user-controlled ids hide a second owner', async () => {
    const duplicateOwners = documentWithOneOwner('stage-1');
    duplicateOwners.scenes.push(structuredClone(duplicateOwners.scenes[0]));
    mocks.loadDocument.mockResolvedValue(duplicateOwners);

    const { exclusive, activePersistedRefs } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(activePersistedRefs?.referenceCounts.get(ASSET)).toBe(2);
    expect(exclusive).toBe(false);
  });

  /**
   * A probe that could not be carried out proves nothing, so it must not be
   * read as "nobody else is editing".
   */
  it('is not exclusive when presence cannot be probed', async () => {
    mocks.probeStageRealmPresence.mockResolvedValue('unknown');

    const { exclusive } = await proveExclusiveAssetOwnership(ASSET, 'stage-1');

    expect(exclusive).toBe(false);
  });
});
