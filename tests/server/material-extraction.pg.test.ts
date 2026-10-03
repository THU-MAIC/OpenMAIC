/**
 * Extraction at upload on PostgreSQL: the owner material's extraction state
 * machine, the background extractor's lease (claim, heartbeat, takeover after
 * a crash), the reuse of a ready extraction of the same bytes, failure and
 * Retry, a delete during an extraction, and how a run's material step reads,
 * waits for, starts or fails on the stored extractions.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimOwnerMaterialExtraction,
  deleteOwnerMaterial,
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  getOwnerMaterial,
  registerOwnerMaterial,
  startOwnerMaterialExtractions,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { defaultRunStepServices } from '@/lib/server/generation/run/services';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  deleteMaterialObjects,
  materialExtractionResultKey,
  setMaterialByteStoreForTests,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  MaterialExtractionFailedError,
  runNextOwnerMaterialExtraction,
  startOwnerMaterialExtractor,
  type MaterialExtractionDependencies,
} from '@/lib/server/materials/extraction';
import type { ExtractionServices } from '@/lib/server/material-extraction/services';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_material_extraction_test';
const OWNER = 'anon:6f1d2c3b-4a5e-4f6a-8b7c-9d0e1f2a3b4c';
const OTHER = 'anon:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const UNTIL = { timeout: 20_000, interval: 25 };

class MemoryByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: MaterialByteInput): Promise<void> {
    this.objects.set(key, Buffer.from(body as Uint8Array));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error(`no object ${key}`), { code: 'ENOENT' });
    return value;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const SERVICES: ExtractionServices = { document: null, documentStatus: 'unassigned' };

function parsed(text: string, images = 0): ParsedPdfContent {
  return {
    text,
    images: [],
    metadata: {
      pageCount: 2,
      parser: 'plain-text',
      pdfImages: Array.from({ length: images }, (_, index) => ({
        id: `img_${index + 1}`,
        src: `data:image/png;base64,${PNG.toString('base64')}`,
        pageNumber: 1,
        description: `figure ${index + 1}`,
      })),
    },
  } as ParsedPdfContent;
}

describe.skipIf(!contractUrl)('material extraction at upload on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let bytes: MemoryByteStore;
  const previousUrl = process.env.DATABASE_URL;
  let analyzed: string[];

  const deps = (
    analyze: (fileName: string) => Promise<ParsedPdfContent> = async (name) => parsed(name),
    services: ExtractionServices = SERVICES,
  ): MaterialExtractionDependencies & { leaseTtlMs: number; heartbeatIntervalMs: number } => ({
    byteStore: bytes,
    services: async () => services,
    analyze: async (input) => {
      analyzed.push(input.source.fileName);
      return analyze(input.source.fileName);
    },
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 50,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=material-extraction`;
    process.env.DATABASE_URL = databaseUrl;
    await getServerPersistenceProvider(databaseUrl, () => pool);
    await ensureOwnerMaterialSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE owner_material');
    bytes = new MemoryByteStore();
    setMaterialByteStoreForTests(bytes);
    analyzed = [];
  });

  afterAll(async () => {
    setMaterialByteStoreForTests(null);
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  /** An upload as `POST /api/materials` makes it: bytes stored, finalized. */
  async function upload(
    name: string,
    { owner = OWNER, sha = name, extract = true, mime = 'text/plain' } = {},
  ) {
    const id = `mat_${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const ossKey = `materials/${owner.replace(/[^A-Za-z0-9._-]/g, '_')}/${id}`;
    await registerOwnerMaterial(
      pool,
      { id, ownerId: owner, kind: 'source', mime, bytes: 5, originalName: name, ossKey },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    await bytes.put(ossKey, Buffer.from(name));
    const record = await finalizeOwnerMaterial(pool, id, 5, sha, { extract });
    return record;
  }

  const read = async (id: string, owner = OWNER) => (await getOwnerMaterial(pool, owner, id))!;

  it('extracts an upload in the background and stores its result next to its bytes', async () => {
    const material = await upload('notes.txt');
    expect(material.extraction).toMatchObject({ status: 'extracting' });
    expect(
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('x'.repeat(10), 2)),
      ),
    ).toBe(true);
    const done = await read(material.id);
    expect(done.extraction).toMatchObject({
      status: 'ready',
      textChars: 10,
      pageCount: 2,
      imageCount: 2,
      extractor: 'plain-text',
    });
    expect(done.extraction?.truncated).toBeUndefined();
    const stored = JSON.parse(
      bytes.objects.get(materialExtractionResultKey(material.ossKey))!.toString('utf8'),
    );
    expect(stored).toMatchObject({ version: 1, text: 'x'.repeat(10), pageCount: 2 });
    expect(stored.images).toHaveLength(2);
    // Nothing else is left to claim.
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(false);
  });

  it('records what a course would leave out of a long material', async () => {
    const material = await upload('long.txt');
    await runNextOwnerMaterialExtraction(
      'worker-a',
      deps(async () => parsed('y'.repeat(80_000), 25)),
    );
    const truncated = (await read(material.id)).extraction?.truncated;
    expect(truncated?.textChars).toBeGreaterThan(0);
    expect(truncated?.textChars).toBeLessThan(80_000);
    expect(truncated?.images).toEqual({ total: 25, max: 20 });
  });

  it('leaves a deferred upload idle, and starts it on demand', async () => {
    const material = await upload('deferred.txt', { extract: false });
    expect(material.extraction).toEqual({ status: 'idle' });
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(false);
    expect(await startOwnerMaterialExtractions(pool, [material.id], ['idle'])).toEqual([
      material.id,
    ]);
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(true);
    expect((await read(material.id)).extraction?.status).toBe('ready');
  });

  it('reuses a ready extraction of the same bytes under the same services', async () => {
    const first = await upload('a.pdf', { sha: 'same' });
    await runNextOwnerMaterialExtraction(
      'worker-a',
      deps(async () => parsed('shared', 1)),
    );
    expect(analyzed).toEqual(['a.pdf']);

    const again = await upload('a-copy.pdf', { sha: 'same' });
    await runNextOwnerMaterialExtraction('worker-a', deps());
    expect(analyzed).toEqual(['a.pdf']);
    expect((await read(again.id)).extraction).toMatchObject({ status: 'ready', textChars: 6 });
    expect(bytes.objects.get(materialExtractionResultKey(again.ossKey))).toEqual(
      bytes.objects.get(materialExtractionResultKey(first.ossKey)),
    );

    // Uploaded twice at once: the second waits for the first, then reuses it.
    const early = await upload('d.pdf', { sha: 'twice' });
    const late = await upload('d-again.pdf', { sha: 'twice' });
    expect((await claimOwnerMaterialExtraction(pool, 'worker-a', 10_000))?.id).toBe(early.id);
    expect(await claimOwnerMaterialExtraction(pool, 'worker-b', 10_000)).toBeNull();
    await pool.query(
      'UPDATE owner_material SET extraction_worker = NULL, extraction_heartbeat_at = NULL WHERE id = $1',
      [early.id],
    );
    await runNextOwnerMaterialExtraction('worker-a', deps());
    await runNextOwnerMaterialExtraction('worker-b', deps());
    expect(analyzed).toEqual(['a.pdf', 'd.pdf']);
    expect((await read(late.id)).extraction?.status).toBe('ready');
    analyzed.splice(1);

    // Not across owners, and not once the owner's document service changed.
    await upload('b.pdf', { sha: 'same', owner: OTHER });
    await runNextOwnerMaterialExtraction('worker-a', deps());
    expect(analyzed).toEqual(['a.pdf', 'b.pdf']);
    await upload('c.pdf', { sha: 'same' });
    await runNextOwnerMaterialExtraction(
      'worker-a',
      deps(undefined, { document: null, documentStatus: 'disabled' }),
    );
    expect(analyzed).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('fails with the extractor error, and Retry extracts it again', async () => {
    const material = await upload('broken.pdf');
    await runNextOwnerMaterialExtraction(
      'worker-a',
      deps(async () => {
        throw new StepRefusal('no-content', 'No text could be extracted from "broken.pdf".');
      }),
    );
    expect((await read(material.id)).extraction).toMatchObject({
      status: 'failed',
      errorCode: 'no-content',
      error: 'No text could be extracted from "broken.pdf".',
      retryable: false,
    });
    // A failed extraction is not claimed again by itself.
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(false);
    expect(await startOwnerMaterialExtractions(pool, [material.id], ['failed'], OTHER)).toEqual([]);
    expect(await startOwnerMaterialExtractions(pool, [material.id], ['failed'], OWNER)).toEqual([
      material.id,
    ]);
    // A running or ready extraction is not restarted.
    expect(await startOwnerMaterialExtractions(pool, [material.id], ['failed', 'idle'])).toEqual(
      [],
    );
    await runNextOwnerMaterialExtraction('worker-a', deps());
    expect((await read(material.id)).extraction?.status).toBe('ready');
  });

  it('takes an extraction over once its worker stopped heartbeating (a crash)', async () => {
    const material = await upload('crash.pdf');
    // Worker A claims it and dies.
    expect((await claimOwnerMaterialExtraction(pool, 'worker-a', 10_000))?.id).toBe(material.id);
    // A live lease is not taken.
    expect(await claimOwnerMaterialExtraction(pool, 'worker-b', 10_000)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Stale after the TTL: a restarted process resumes it.
    expect(await runNextOwnerMaterialExtraction('worker-b', { ...deps(), leaseTtlMs: 50 })).toBe(
      true,
    );
    expect((await read(material.id)).extraction?.status).toBe('ready');
    // The dead worker's late settlement is refused (the lease is gone).
    const { settleOwnerMaterialExtraction } = await import('@/lib/persistence/owner-materials');
    expect(
      await settleOwnerMaterialExtraction(pool, material.id, 'worker-a', { status: 'failed' }),
    ).toBe(false);
  });

  it('drops an extraction whose material is deleted while it runs, leaving nothing behind', async () => {
    const material = await upload('gone.pdf');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const job = runNextOwnerMaterialExtraction(
      'worker-a',
      deps(async () => {
        started();
        await blocked;
        return parsed('late');
      }),
    );
    await running;
    expect(
      await deleteOwnerMaterial(pool, OWNER, material.id, (key) =>
        deleteMaterialObjects(bytes, key),
      ),
    ).toBe(true);
    release();
    await job;
    expect(await read(material.id).catch(() => null)).toBeNull();
    expect([...bytes.objects.keys()].filter((key) => key.includes(material.id))).toEqual([]);
  });

  describe('a run reading the materials', () => {
    let extractor: ReturnType<typeof startOwnerMaterialExtractor> | null = null;
    afterAll(async () => {
      await extractor?.stop();
    });

    it('reads ready materials, waits for extracting ones, starts idle ones', async () => {
      const ready = await upload('ready.txt');
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('ready text', 1)),
      );
      expect(await defaultRunStepServices.materialsReady(OWNER, [ready.id])).toBe(true);

      const extracting = await upload('extracting.txt');
      const idle = await upload('idle.txt', { extract: false });
      expect(
        await defaultRunStepServices.materialsReady(OWNER, [ready.id, extracting.id, idle.id]),
      ).toBe(false);

      const ids = [ready.id, extracting.id, idle.id];
      const step = defaultRunStepServices.analyzeMaterials(OWNER, ids, {
        log: console as never,
        signal: new AbortController().signal,
      });
      // The run started the idle one; a worker extracts both.
      await expect
        .poll(async () => (await read(idle.id)).extraction?.status, UNTIL)
        .toBe('extracting');
      extractor = startOwnerMaterialExtractor({ ...deps(async (name) => parsed(`${name} text`)) });
      const analyzedMaterials = await step;
      expect(analyzedMaterials.text).toContain('ready text');
      expect(analyzedMaterials.text).toContain('extracting.txt text');
      expect(analyzedMaterials.text).toContain('idle.txt text');
      // The images come back with their bytes, as the run stores them as course assets.
      expect(analyzedMaterials.images).toEqual([
        expect.objectContaining({ id: 'img_1', description: 'figure 1', mimeType: 'image/png' }),
      ]);
      expect(Buffer.from(analyzedMaterials.images[0]!.bytes)).toEqual(PNG);
      expect(analyzed.filter((name) => name === 'ready.txt')).toHaveLength(1);
    });

    it('fails with the extraction error of a failed material', async () => {
      const failed = await upload('failed.txt');
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => {
          throw new Error('document extraction failed (unpdf: bad xref)');
        }),
      );
      await expect(
        defaultRunStepServices.analyzeMaterials(OWNER, [failed.id], {
          log: console as never,
        }),
      ).rejects.toMatchObject({
        name: 'MaterialExtractionFailedError',
        message: 'document extraction failed (unpdf: bad xref)',
      });
      expect(MaterialExtractionFailedError.prototype).toBeInstanceOf(StepRefusal);
    });

    it('stops waiting when the run is aborted (its deadline)', async () => {
      await extractor?.stop();
      extractor = null;
      const waiting = await upload('slow.txt');
      const abort = new AbortController();
      const step = defaultRunStepServices.analyzeMaterials(OWNER, [waiting.id], {
        log: console as never,
        signal: abort.signal,
      });
      abort.abort(new Error('deadline'));
      await expect(step).rejects.toThrow('deadline');
    });
  });
});
