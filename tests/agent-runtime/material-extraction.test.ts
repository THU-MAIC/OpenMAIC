import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  deleteOwnedSessionWithMaterials,
  discardSessionMaterialObjectWrite,
  finalizeSessionMaterialObjectWrite,
  storeSessionMaterialRawAsset,
} from '@/lib/server/agent-runtime/session-materials';
import { extractClaimedSessionMaterial } from '@/lib/server/material-extraction/extract';
import {
  runNextMaterialExtraction,
  startMaterialExtractionRunner,
} from '@/lib/server/material-extraction/runner';
import { LocalMediaExtractionError } from '@/lib/document/extractors/local-media';
import type { MediaExtractorProvider } from '@/lib/document';
import { LocalMaterialByteStore } from '@/lib/server/materials/bytes';
import { sessionMaterialObjectKey } from '@/lib/server/materials/object-keys';

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
    db = undefined;
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

  it('removes an uncommitted text derivative when the extraction lease is fenced', async () => {
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
      title: 'notes.txt',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_source');
    const claim = await materials.claimNextExtraction('worker-1', { leaseTtlMs: 10_000 });
    const removeAsset = vi.fn().mockResolvedValue(undefined);

    await expect(
      extractClaimedSessionMaterial(claim!, {
        resolveSource: async () => ({ bytes: Buffer.from('lesson'), mime: 'text/plain' }),
        configuredProviderIds: () => [],
        putText: async () => 'materials/v1/sessions/safe/material/text.md',
        complete: async () => false,
        removeAsset,
      }),
    ).rejects.toThrow('lease lost');
    expect(removeAsset).toHaveBeenCalledWith(
      'session-1',
      'materials/v1/sessions/safe/material/text.md',
    );
  });

  it('settles a rejected extractor with a closed public error code', async () => {
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
      error: 'MATERIAL_EXTRACTION_FAILED',
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
      error: 'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
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

  it('removes earlier media assets when a later derivative byte write fails', async () => {
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
    const removeAsset = vi.fn().mockResolvedValue(undefined);
    const putBytes = vi
      .fn()
      .mockResolvedValueOnce('ast_frame_1')
      .mockRejectedValueOnce(new Error('second image write failed'));
    const complete = vi.fn();

    await expect(
      extractClaimedSessionMaterial(claim!, {
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
                data: Buffer.from('first').toString('base64'),
              },
              {
                id: 'frame-2',
                type: 'image',
                mimeType: 'image/webp',
                data: Buffer.from('second').toString('base64'),
              },
            ],
          })),
        ],
        putText: async () => 'ast_transcript',
        putBytes,
        complete,
        removeAsset,
      }),
    ).rejects.toThrow('second image write failed');
    expect(removeAsset).toHaveBeenCalledWith('session-1', 'ast_transcript');
    expect(removeAsset).toHaveBeenCalledWith('session-1', 'ast_frame_1');
    expect(complete).not.toHaveBeenCalled();
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
      error: 'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
    });
    const retryClaim = await materials.claimNextExtraction('cleanup-worker', {
      leaseTtlMs: 10_000,
    });
    await materials.settleExtractionFailure(
      retryClaim!.material.id,
      'cleanup-worker',
      'MATERIAL_EXTRACTION_FAILED',
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
      error: 'MATERIAL_EXTRACTION_FAILED',
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
      error: 'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
    });
  });

  it('logs only a closed code when queue scanning fails', async () => {
    const privateDiagnostic =
      'provider stderr C:\\private\\student\\paper.pdf materials/v1/sessions/secret/raw.pdf';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = startMaterialExtractionRunner({
      getStore: async () => {
        throw new Error(privateDiagnostic);
      },
    });

    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    await runner.stop({ timeoutMs: 100 });

    expect(logged).toHaveBeenCalledWith('[material-extraction] scan failed', {
      code: 'MATERIAL_EXTRACTION_FAILED',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(privateDiagnostic);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(
      /provider stderr|C:\\private|materials\/v1\/sessions/,
    );
  });

  it('drains a durable extraction write claim when deletion wins before completion', async () => {
    db = new PGlite();
    const root = await mkdtemp(join(tmpdir(), 'openmaic-extraction-race-'));
    try {
      await db.waitReady;
      await ensureAgentSessionSchema(db);
      await ensureAgentSessionMaterialSchema(db);
      const sessions = new PgAgentSessionStore(db, {
        withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
      });
      const materials = new PgAgentSessionMaterialStore(db, {
        withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
      });
      const byteStore = new LocalMaterialByteStore(root);
      const sessionId = 'session-extraction-race';
      await sessions.createSession({ id: sessionId, ownerId: 'owner-1', prompt: 'extract' });
      await materials.createMaterial(sessionId, {
        id: 'mat_source',
        kind: 'source',
        title: 'notes.txt',
        rawAssetId: sessionMaterialObjectKey(sessionId, 'mat_source', 'raw.dGV4dC9wbGFpbg'),
      });
      await materials.enqueueExtraction(sessionId, 'mat_source');
      const claim = await materials.claimNextExtraction('worker-1', { leaseTtlMs: 10_000 });
      expect(claim).not.toBeNull();

      let releaseWriter!: () => void;
      const writerReleased = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let stagedWrite!: Awaited<ReturnType<typeof storeSessionMaterialRawAsset>>;
      let markStaged!: () => void;
      const staged = new Promise<void>((resolve) => {
        markStaged = resolve;
      });
      const writeDependencies = { byteStore, materialStore: materials };
      const extraction = extractClaimedSessionMaterial(claim!, {
        resolveSource: async () => ({ bytes: Buffer.from('lesson'), mime: 'text/plain' }),
        configuredProviderIds: () => [],
        putText: async (targetSessionId, bytes, output) => {
          stagedWrite = await storeSessionMaterialRawAsset(
            targetSessionId,
            output.id,
            output.kind,
            bytes,
            'text/markdown',
            {
              derivedFrom: output.derivedFrom,
              objectSlot: 'text',
              dependencies: writeDependencies,
            },
          );
          markStaged();
          await writerReleased;
          return stagedWrite;
        },
        complete: materials.completeExtraction.bind(materials),
        finalizeObjectWrite: (write) =>
          finalizeSessionMaterialObjectWrite(write, writeDependencies),
        discardObjectWrite: (write) => discardSessionMaterialObjectWrite(write, writeDependencies),
      }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

      await staged;
      await expect(
        deleteOwnedSessionWithMaterials(sessionId, 'owner-1', {
          byteStore,
          sessionStore: sessions,
          materialStore: materials,
        }),
      ).resolves.toBe(true);
      releaseWriter();

      expect(await extraction).toMatchObject({ status: 'rejected' });
      await expect(byteStore.get(stagedWrite.objectKey)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        materials.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, 'owner-1'),
      ).resolves.toEqual([]);
      await expect(materials.getMaterial(sessionId, stagedWrite.materialId)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
