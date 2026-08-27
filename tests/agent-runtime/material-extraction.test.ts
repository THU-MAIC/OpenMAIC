import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';

import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { extractClaimedSessionMaterial } from '@/lib/server/material-extraction/extract';
import { runNextMaterialExtraction } from '@/lib/server/material-extraction/runner';
import { LocalMediaExtractionError } from '@/lib/document/extractors/local-media';
import type { MediaExtractorProvider } from '@/lib/document';

function mediaProvider(
  extract: MediaExtractorProvider['extract'],
  available = true,
): MediaExtractorProvider {
  return {
    id: 'test-media',
    displayName: 'Test media',
    version: '1',
    supportedMimeTypes: ['video/mp4'],
    capabilities: {
      transcript: true,
      keyframes: true,
      synopsis: false,
      ocr: false,
      async: false,
    },
    availability: vi.fn(async () => ({ available })),
    extract,
  };
}

describe('uploaded material extraction lifecycle', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
  });

  it('uploads a source, extracts it through the registry, and reads the extracted text', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    const source = await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      title: 'notes.txt',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', source.id);
    const claim = await materials.claimNextExtraction('worker-1', { leaseTtlMs: 10_000 });
    expect(claim).not.toBeNull();

    const assets = new Map<string, Buffer>();
    const extraction = await extractClaimedSessionMaterial(claim!, {
      resolveSource: async () => ({
        bytes: Buffer.from('The uploaded lesson text.'),
        mime: 'text/plain',
      }),
      configuredProviderIds: () => [],
      putText: async (_sessionId, text) => {
        assets.set('ast_extracted', text);
        return 'ast_extracted';
      },
      complete: materials.completeExtraction.bind(materials),
    });

    const derivative = await materials.getMaterial('session-1', extraction.materialId);
    expect(derivative).toMatchObject({
      kind: 'extraction',
      derivedFrom: source.id,
      textAssetId: 'ast_extracted',
    });
    const read = buildMaterialTools({
      sessionId: 'session-1',
      getMaterial: materials.getMaterial.bind(materials),
      readTextAsset: async (_sessionId, assetId) => assets.get(assetId) ?? null,
    }).find((candidate) => candidate.name === 'read_material') as AgentTool<never, never>;
    const result = await read.execute('read', { materialId: derivative!.id } as never);
    expect((result.content[0] as { text: string }).text).toContain('The uploaded lesson text.');
    expect((await materials.getMaterial('session-1', source.id))?.extraction.status).toBe('done');
  });

  it('settles a rejected extractor as failed with its reason', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_source');

    expect(
      await runNextMaterialExtraction(materials, 'worker-1', async () => {
        throw new Error('extractor rejected input');
      }),
    ).toBe(true);
    expect((await materials.getMaterial('session-1', 'mat_source'))?.extraction).toEqual({
      status: 'failed',
      attempts: 0,
      error: 'extractor rejected input',
    });
  });

  it('requeues an extractor failure with a concrete transient signal', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_source');

    await runNextMaterialExtraction(materials, 'worker-1', async () => {
      const error = new Error('connection reset') as Error & { code: string };
      error.code = 'ECONNRESET';
      throw error;
    });
    expect((await materials.getMaterial('session-1', 'mat_source'))?.extraction).toEqual({
      status: 'pending',
      attempts: 1,
      error: 'connection reset',
    });
  });

  it('persists a media transcript and prepared images through the asset registry', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_media',
      kind: 'source',
      title: 'lesson.mp4',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_media');
    const claim = await materials.claimNextExtraction('worker-1', { leaseTtlMs: 10_000 });
    const stored = new Map<string, Buffer>();

    const result = await extractClaimedSessionMaterial(claim!, {
      resolveSource: async () => ({ bytes: Buffer.from('video'), mime: 'video/mp4' }),
      mediaProviders: () => [
        mediaProvider(async () => ({
          metadata: { durationMs: 2_000, providerId: 'test-media' },
          transcript: [{ id: 'segment-1', startMs: 0, endMs: 2_000, text: 'Hello media.' }],
          assets: [
            {
              id: 'frame-1',
              type: 'image',
              mimeType: 'image/webp',
              data: Buffer.from('prepared-webp').toString('base64'),
            },
          ],
        })),
      ],
      putText: async (_sessionId, bytes) => {
        stored.set('ast_transcript', bytes);
        return 'ast_transcript';
      },
      putBytes: async (_sessionId, bytes) => {
        stored.set('ast_frame', bytes);
        return 'ast_frame';
      },
      complete: materials.completeExtraction.bind(materials),
    });

    expect(result.text).toContain('[00:00:00.000 - 00:00:02.000] Hello media.');
    expect(stored.get('ast_frame')?.toString()).toBe('prepared-webp');
    const derivatives = (await materials.listMaterials('session-1')).filter(
      (material) => material.derivedFrom === 'mat_media',
    );
    expect(derivatives.map((material) => material.kind).sort()).toEqual(['image', 'transcript']);
  });

  it('retries a transient ASR failure and permanently fails a rejected ASR request', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_transient',
      kind: 'source',
      rawAssetId: 'ast_transient',
    });
    await materials.enqueueExtraction('session-1', 'mat_transient');
    await runNextMaterialExtraction(materials, 'worker-1', (claim) =>
      extractClaimedSessionMaterial(claim, {
        resolveSource: async () => ({ bytes: Buffer.from('video'), mime: 'video/mp4' }),
        mediaProviders: () => [
          mediaProvider(async () => {
            throw new LocalMediaExtractionError('ASR HTTP status 503', true);
          }),
        ],
      }),
    );

    expect((await materials.getMaterial('session-1', 'mat_transient'))?.extraction).toEqual({
      status: 'pending',
      attempts: 1,
      error: 'ASR HTTP status 503',
    });
    const retryClaim = await materials.claimNextExtraction('cleanup-worker', {
      leaseTtlMs: 10_000,
    });
    await materials.settleExtractionFailure(
      retryClaim!.material.id,
      'cleanup-worker',
      'stop retrying in this test',
      false,
    );

    await materials.createMaterial('session-1', {
      id: 'mat_permanent',
      kind: 'source',
      rawAssetId: 'ast_permanent',
    });
    await materials.enqueueExtraction('session-1', 'mat_permanent');
    await runNextMaterialExtraction(materials, 'worker-1', (claim) =>
      extractClaimedSessionMaterial(claim, {
        resolveSource: async () => ({ bytes: Buffer.from('video'), mime: 'video/mp4' }),
        mediaProviders: () => [
          mediaProvider(async () => {
            throw new LocalMediaExtractionError('ASR HTTP status 400', false);
          }),
        ],
      }),
    );
    expect((await materials.getMaterial('session-1', 'mat_permanent'))?.extraction).toEqual({
      status: 'failed',
      attempts: 0,
      error: 'ASR HTTP status 400',
    });
  });

  it('fails cleanly with both media enablement paths when no provider is available', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_unavailable',
      kind: 'source',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_unavailable');

    await runNextMaterialExtraction(materials, 'worker-1', (claim) =>
      extractClaimedSessionMaterial(claim, {
        resolveSource: async () => ({ bytes: Buffer.from('video'), mime: 'video/mp4' }),
        mediaProviders: () => [mediaProvider(vi.fn(), false)],
      }),
    );

    expect((await materials.getMaterial('session-1', 'mat_unavailable'))?.extraction).toEqual({
      status: 'failed',
      attempts: 0,
      error: expect.stringMatching(/Configure AliDocMind credentials.*install ffmpeg.*server ASR/i),
    });
  });
});
