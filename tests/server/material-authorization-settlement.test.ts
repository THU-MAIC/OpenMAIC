import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAgentSessionSchema, PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import {
  ensureAgentSessionMaterialSchema,
  PgAgentSessionMaterialStore,
} from '@openmaic/storage/material/pg';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import {
  setDeploymentConfigForTests,
  setWorkspaceLayerLoaderForTests,
} from '@/lib/server/model-config/runtime';
import { resolveExtractionServices } from '@/lib/server/material-extraction/services';
import {
  extractClaimedSessionMaterial,
  extractMaterialSource,
} from '@/lib/server/material-extraction/extract';
import { runNextMaterialExtraction } from '@/lib/server/material-extraction/runner';
import { runClaimedOwnerMaterialExtraction } from '@/lib/server/materials/extraction';
import { buildFetchUrlTool } from '@/lib/server/agent-runtime/fetch-url';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import type { MediaExtractorProvider } from '@/lib/document';
const mocks = vi.hoisted(() => ({
  settle: vi.fn(async () => true),
  host: vi.fn(() => ({ errorCode: 'HOST_FAILURE', retryable: true })),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  isOwnerRetired: async () => false,
  canonicalizeStoredOwner: async (ownerId: string) => ownerId,
}));
vi.mock('@/lib/persistence/owner-materials', async (original) => ({
  ...(await original<typeof import('@/lib/persistence/owner-materials')>()),
  findReusableOwnerMaterialExtraction: async () => null,
  heartbeatOwnerMaterialExtraction: async () => true,
  settleOwnerMaterialExtraction: mocks.settle,
}));
vi.mock('@/lib/server/generation-run-hooks/runtime', async (original) => ({
  ...(await original<typeof import('@/lib/server/generation-run-hooks/runtime')>()),
  classifyHostFailure: mocks.host,
}));
let db: PGlite | undefined;
beforeEach(() => {
  mocks.settle.mockClear();
  mocks.host.mockClear();
  vi.stubEnv('DATABASE_URL', '');
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: {
          speech: {
            preset: 'openai-whisper',
            apiKey: 'server-key',
            models: ['gpt-4o-mini-transcribe'],
          },
        },
      },
    },
    legacy: false,
    notices: [],
  });
  setWorkspaceLayerLoaderForTests(async () => ({
    source: 'workspace',
    config: { slots: { asr: 'speech:whisper-1' } },
  }));
});
afterEach(async () => {
  await db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  setDeploymentConfigForTests();
  setWorkspaceLayerLoaderForTests();
});
const unavailableMedia: MediaExtractorProvider = {
  id: 'local-ffmpeg',
  displayName: 'Test media',
  version: '1',
  supportedMimeTypes: ['audio/wav'],
  capabilities: { transcript: true, keyframes: false, synopsis: false, ocr: false, async: false },
  availability: async () => ({ available: false }),
  extract: async () => {
    throw Error('must not extract');
  },
};
it('stale ASR assignment leaves documents, PDF and agent URL fetch usable', async () => {
  const services = await resolveExtractionServices('owner', { forward: false });
  expect(services.asr).toBeUndefined();
  expect(services.asrError).toBeInstanceOf(ModelAuthorizationError);
  for (const mime of ['application/pdf', 'text/plain']) {
    const result = await extractMaterialSource(
      { bytes: Buffer.from('document'), mime },
      {
        services,
        providers: () => [
          {
            id: 'text',
            displayName: 'Text',
            version: '1',
            supportedMimeTypes: [mime],
            capabilities: {
              text: true,
              images: false,
              layout: false,
              tables: false,
              ocr: false,
              formulas: false,
              async: false,
            },
            extract: async () => ({
              blocks: [{ id: '1', type: 'text', text: 'Extracted document' }],
              assets: [],
              metadata: {},
            }),
          },
        ],
        mediaProviders: () => [],
      },
    );
    expect(result.text).toBe('Extracted document');
  }
  const fetchUrl = vi.fn(async () => ({
    sourceUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    title: 'Page',
    contentType: 'text/plain',
    downloadedBytes: 9,
    markdown: 'Page text',
    fetchedAt: new Date().toISOString(),
    truncated: false,
  }));
  const tool = buildFetchUrlTool({
    sessionId: 'session',
    ownerId: 'owner',
    isUrlAllowed: async () => true,
    fetchUrl,
    saveWebMaterial: async () => ({ id: 'web' }) as never,
  });
  await tool.execute('fetch', { url: 'https://example.com' } as never);
  expect(fetchUrl).toHaveBeenCalled();
});
it('session worker settles an ASR refusal as non-retryable with the fixed message', async () => {
  db = new PGlite();
  await db.waitReady;
  await ensureAgentSessionSchema(db);
  await ensureAgentSessionMaterialSchema(db);
  await new PgAgentSessionStore(db, {
    withTransaction: (body) => db!.transaction((tx) => body(tx)),
  }).createSession({ id: 'session', ownerId: 'owner', prompt: 'p' });
  const store = new PgAgentSessionMaterialStore(db);
  await store.createMaterial('session', { id: 'source', kind: 'source', rawAssetId: 'raw' });
  await store.enqueueExtraction('session', 'source');
  await runNextMaterialExtraction(store, 'worker', (claim) =>
    extractClaimedSessionMaterial(claim, {
      sessionOwner: async () => 'owner',
      resolveSource: async () => ({ bytes: Buffer.from('audio'), mime: 'audio/wav' }),
      mediaProviders: () => [unavailableMedia],
    }),
  );
  expect((await store.getMaterial('session', 'source'))?.extraction).toEqual({
    status: 'failed',
    attempts: 0,
    error: new ModelAuthorizationError().message,
  });
  await store.enqueueExtraction('session', 'source');
  expect((await store.getMaterial('session', 'source'))?.extraction).toEqual({
    status: 'pending',
    attempts: 0,
  });
});
it('owner worker settles ASR authorization with 403 before host classification', async () => {
  const material = {
    id: 'source',
    ownerId: 'owner',
    ossKey: 'raw',
    originalName: 'clip.wav',
    mime: 'audio/wav',
    bytes: 5,
  } as OwnerMaterialRecord;
  await runClaimedOwnerMaterialExtraction(
    { material, lease: 'worker', attempt: 'attempt' },
    {
      heartbeatIntervalMs: 10000,
      byteStore: {
        put: async () => {},
        get: async () => Buffer.from('audio'),
        delete: async () => {},
        deletePrefix: async () => {},
        list: async () => [],
      },
      services: (owner) => resolveExtractionServices(owner, { forward: false }),
      analyze: async (input) => {
        await extractMaterialSource(
          { bytes: Buffer.from('audio'), mime: 'audio/wav' },
          { services: input.services, mediaProviders: () => [unavailableMedia] },
        );
        throw Error('must fail ASR');
      },
    },
  );
  expect(mocks.settle).toHaveBeenCalledWith({}, 'source', 'worker', {
    status: 'failed',
    error: new ModelAuthorizationError().message,
    errorCode: 'PROVIDER_DISABLED',
    httpStatus: 403,
    retryable: false,
  });
  expect(mocks.host).not.toHaveBeenCalled();
});
