import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';

const state = vi.hoisted(() => ({
  inTransaction: false,
  read: vi.fn(),
  parse: vi.fn(),
  row: undefined as unknown,
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  forwardOwnerWrite: vi.fn(async () => 'user:alice'),
}));
vi.mock('@/lib/server/material-extraction/document-images', () => ({
  resolveDerivativeRefsAsync: state.parse,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    assetStore: { resolve: async () => null },
    assetStoreIn: () => ({ resolve: state.read }),
    withTransaction: async (body: (tx: unknown) => Promise<unknown>) => {
      state.inTransaction = true;
      try {
        return await body({ query: async () => ({ rows: state.row ? [state.row] : [] }) });
      } finally {
        state.inTransaction = false;
      }
    },
  }),
}));
const result = {
  revision: 'new-revision',
  text: { assetId: 'text', chars: 1 },
  derivatives: [
    {
      id: 'own-image',
      key: 'img-1',
      kind: 'image' as const,
      assetId: 'image',
      title: 'Image',
      mime: 'image/webp',
      bytes: 1,
      sha256: 'image-sha',
    },
  ],
};
const location = { id: 'source', ownerId: 'anon:stale', extractionResult: result };

beforeEach(() => {
  state.read.mockReset();
  state.parse.mockReset();
  state.row = { owner_id: 'user:alice', deleted_at: null, extraction_result: result };
  state.read.mockResolvedValue({
    bytes: Buffer.from('![x](openmaic-derivative:img-1)'),
    revision: 7,
  });
});
afterEach(() => vi.restoreAllMocks());

it('commits the fenced byte read before awaiting legacy parsing', async () => {
  let entered!: () => void;
  const parsing = new Promise<void>((resolve) => (entered = resolve));
  let finish!: (text: string) => void;
  state.parse.mockImplementation(() => {
    entered();
    return new Promise<string>((resolve) => (finish = resolve));
  });
  const reading = readOwnerMaterialText(location);
  await parsing;
  try {
    expect(state.inTransaction).toBe(false);
    expect(state.parse).toHaveBeenCalledWith(
      '![x](openmaic-derivative:img-1)',
      result.derivatives,
      JSON.stringify(['user:alice', 'text', 'new-revision', 7]),
      undefined,
      undefined,
    );
  } finally {
    finish('![x](material:own-image)');
  }
  await expect(reading).resolves.toEqual({
    text: '![x](material:own-image)',
    revision: 'new-revision',
  });
});

it('still returns null when the fenced bytes or the parser fail', async () => {
  state.read.mockRejectedValueOnce(new Error('unavailable'));
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.parse).not.toHaveBeenCalled();
  state.parse.mockRejectedValueOnce(new Error('parser failed'));
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.inTransaction).toBe(false);
});

it('does not parse a tombstone found by the fenced re-read', async () => {
  state.row = { owner_id: 'user:alice', deleted_at: 1, extraction_result: result };
  await expect(readOwnerMaterialText(location)).resolves.toBeNull();
  expect(state.read).not.toHaveBeenCalled();
  expect(state.parse).not.toHaveBeenCalled();
});

it('passes cancellation to parsing and propagates it instead of returning null', async () => {
  const controller = new AbortController();
  state.parse.mockImplementation(async (_text, _derivatives, _key, _refs, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    throw new Error('aborted');
  });
  await expect(readOwnerMaterialText(location, controller.signal)).rejects.toThrow('aborted');
  expect(state.read).toHaveBeenCalledOnce();
});

it.each(['read_material', 'search_material'])(
  'propagates %s cancellation through the production resolver and owner reader',
  async (name) => {
    const controller = new AbortController();
    const entry: OwnerMaterialEntry = {
      ...location,
      kind: 'source',
      derivedFrom: null,
      mime: 'application/pdf',
      bytes: 1,
      originalName: 'lesson.pdf',
      ossKey: '',
      assetId: 'source-bytes',

      sha256: 'source-sha',
      status: 'ready',
      extraction: { status: 'done' },
      createdAt: 0,
      deletedAt: null,
      folderId: null,
      displayName: null,
      extractionError: null,
      lineage: null,
      extractionResult: {
        ...result,
        extractor: { id: 'test', version: '1', options: {} },
        stats: {},
        completedAt: 0,
      },
    };
    state.parse.mockImplementation(async (_text, _derivatives, _key, _refs, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new Error('worker canceled');
    });
    const selected = buildMaterialTools({
      sessionId: 'session',
      resolveMaterial: async () => ({ origin: 'owner', entry }),
      listLibrary: async () => [entry],
    }).find((candidate) => candidate.name === name)!;
    await expect(
      selected.execute(
        'call',
        (name === 'read_material'
          ? { materialId: entry.id, scope: 'library' }
          : { query: 'lesson', scope: 'library' }) as never,
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(state.parse).toHaveBeenCalledOnce();
  },
);

it('reads an immutable classic result with a private revision and rejects unreadable stored JSON', async () => {
  const { setMaterialByteStoreForTests } = await import('@/lib/server/materials/bytes');
  const get = vi.fn(async () =>
    Buffer.from(JSON.stringify({ version: 1, text: 'old result', images: [] })),
  );
  setMaterialByteStoreForTests({
    get,
    put: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    list: vi.fn(),
  });
  const legacy = {
    id: 'classic',
    ownerId: 'user:alice',
    extractionResult: null,
    extraction: { status: 'ready' as const, resultKey: 'private/results/attempt-1' },
  };
  state.row = {
    owner_id: legacy.ownerId,
    deleted_at: null,
    extraction_result: null,
    extraction: legacy.extraction,
  };
  try {
    const first = await readOwnerMaterialText(legacy);
    expect(first?.text).toBe('old result');
    expect(first?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await readOwnerMaterialText(legacy)).toEqual(first);
    expect(
      (
        await readOwnerMaterialText({
          ...legacy,
          extraction: { ...legacy.extraction, resultKey: 'private/results/attempt-2' },
        })
      )?.revision,
    ).not.toBe(first?.revision);
    get.mockResolvedValue(Buffer.from('{"version":1,"images":[]}'));
    expect(await readOwnerMaterialText(legacy)).toBeNull();
    get.mockRejectedValue(new Error('private diagnostic: missing object'));
    expect(await readOwnerMaterialText(legacy)).toBeNull();
  } finally {
    setMaterialByteStoreForTests(null);
  }
});
