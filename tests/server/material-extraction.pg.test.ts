/**
 * Extraction at upload on PostgreSQL: the owner material's extraction state
 * machine, the background extractor's leases (claim, heartbeat, takeover after
 * a crash, attempts that overlap), cancellation, the owners' turns, the reuse
 * of a ready extraction of the same bytes, the byte quota, failure and Retry,
 * a delete during an extraction, the sweep of unused uploads, and how a run's
 * material step reads, waits for, starts or fails on the stored extractions.
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildDocumentBundle, type ParsedDocumentPart } from '@/lib/document/bundle';
import {
  claimOwnerMaterialExtraction,
  deleteOwnerMaterial,
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  getOwnerMaterial,
  MaterialQuotaExceededError,
  registerOwnerMaterial,
  settleOwnerMaterialExtraction,
  startOwnerMaterialExtractions,
  touchOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { decodeDataUrl } from '@/lib/server/provider-result-fetch';
import { defaultRunStepServices } from '@/lib/server/generation/run/services';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  deleteMaterialObjects,
  materialExtractionResultPrefix,
  setMaterialByteStoreForTests,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  awaitOwnerMaterialExtractions,
  extractionIdentityKey,
  MaterialExtractionFailedError,
  MaterialExtractionTimeoutError,
  orphanResultAgeMs,
  runClaimedOwnerMaterialExtraction,
  runNextOwnerMaterialExtraction,
  startOwnerMaterialExtractor,
  sweepUnusedOwnerMaterialsNow,
  type MaterialExtractionDependencies,
} from '@/lib/server/materials/extraction';
import type { ExtractionServices } from '@/lib/server/material-extraction/services';
import type { MediaConnection } from '@/lib/server/model-config/media';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_material_extraction_test';
const OWNER = 'anon:6f1d2c3b-4a5e-4f6a-8b7c-9d0e1f2a3b4c';
const OTHER = 'anon:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const UNTIL = { timeout: 20_000, interval: 25 };

class MemoryByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly modifiedAt = new Map<string, number>();
  async put(key: string, body: MaterialByteInput): Promise<void> {
    this.objects.set(key, Buffer.from(body as Uint8Array));
    this.modifiedAt.set(key, Date.now());
  }
  async list(prefix: string): Promise<Array<{ key: string; modifiedAt: number }>> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => ({ key, modifiedAt: this.modifiedAt.get(key) ?? 0 }));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error(`no object ${key}`), { code: 'ENOENT' });
    return value;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
  resultKeys(ossKey: string): string[] {
    return [...this.objects.keys()].filter((key) =>
      key.startsWith(materialExtractionResultPrefix(ossKey)),
    );
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
        pageNumber: index + 1,
        description: `figure ${index + 1}`,
        width: 640,
        height: 480,
      })),
    },
  } as ParsedPdfContent;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

describe.skipIf(!contractUrl)('material extraction at upload on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let bytes: MemoryByteStore;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB:
      process.env.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB,
  };
  let analyzed: string[];

  type Analyze = (fileName: string, signal: AbortSignal) => Promise<ParsedPdfContent>;
  const deps = (
    analyze: Analyze = async (name) => parsed(name),
    services: ExtractionServices = SERVICES,
  ): MaterialExtractionDependencies & {
    leaseTtlMs: number;
    heartbeatIntervalMs: number;
    perOwnerLimit: number;
  } => ({
    byteStore: bytes,
    services: async () => services,
    analyze: async (input, ctx) => {
      analyzed.push(input.source.fileName);
      return analyze(input.source.fileName, ctx.signal!);
    },
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 50,
    perOwnerLimit: 10,
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

  afterEach(() => {
    const value = previousEnv.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB;
    if (value === undefined) delete process.env.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB;
    else process.env.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB = value;
  });

  afterAll(async () => {
    setMaterialByteStoreForTests(null);
    if (previousEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousEnv.DATABASE_URL;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  /** An upload as `POST /api/materials` makes it: bytes stored, finalized. */
  async function upload(
    name: string,
    { owner = OWNER, sha = name, extract = true, mime = 'text/plain', createdAt = 0 } = {},
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
    if (createdAt) {
      await pool.query('UPDATE owner_material SET created_at = $2 WHERE id = $1', [id, createdAt]);
    }
    return record;
  }

  const read = async (id: string, owner = OWNER) => (await getOwnerMaterial(pool, owner, id))!;
  const claim = (
    workerId: string,
    options: Partial<{ leaseTtlMs: number; perOwnerLimit: number; exclude: string[] }> = {},
  ) =>
    claimOwnerMaterialExtraction(pool, workerId, {
      leaseTtlMs: 10_000,
      perOwnerLimit: 10,
      ...options,
    });
  const published = (material: { ossKey: string }) => bytes.resultKeys(material.ossKey);

  it('extracts an upload in the background and publishes its result next to its bytes', async () => {
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
    // One object per attempt, the one the settle published.
    expect(published(material)).toEqual([done.extraction!.resultKey]);
    const stored = JSON.parse(bytes.objects.get(done.extraction!.resultKey!)!.toString('utf8'));
    expect(stored).toMatchObject({ version: 1, text: 'x'.repeat(10), pageCount: 2 });
    expect(stored.images).toHaveLength(2);
    expect(done.extraction?.resultBytes).toBe(
      bytes.objects.get(done.extraction!.resultKey!)!.byteLength,
    );
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
    expect(await startOwnerMaterialExtractions(pool, OWNER, [material.id], ['idle'])).toEqual([
      material.id,
    ]);
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(true);
    expect((await read(material.id)).extraction?.status).toBe('ready');
  });

  describe('reusing a ready extraction of the same bytes', () => {
    it('reuses it under the same identity, and waits for one still extracting', async () => {
      const first = await upload('a.pdf', { sha: 'same' });
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('shared', 1)),
      );
      expect(analyzed).toEqual(['a.pdf']);

      const again = await upload('a-copy.pdf', { sha: 'same' });
      await runNextOwnerMaterialExtraction('worker-a', deps());
      expect(analyzed).toEqual(['a.pdf']);
      const copied = (await read(again.id)).extraction!;
      expect(copied).toMatchObject({ status: 'ready', textChars: 6 });
      // A copy of its own: deleting the first never takes this one's away.
      expect(copied.resultKey).not.toBe((await read(first.id)).extraction!.resultKey);
      expect(bytes.objects.get(copied.resultKey!)).toEqual(
        bytes.objects.get((await read(first.id)).extraction!.resultKey!),
      );

      // Uploaded twice at once: the second waits for the first, then reuses it.
      const early = await upload('d.pdf', { sha: 'twice' });
      const late = await upload('d-again.pdf', { sha: 'twice' });
      const held = await claim('worker-a');
      expect(held?.material.id).toBe(early.id);
      expect(await claim('worker-b')).toBeNull();
      await runClaimedOwnerMaterialExtraction(held!, deps());
      await runNextOwnerMaterialExtraction('worker-b', deps());
      expect(analyzed).toEqual(['a.pdf', 'd.pdf']);
      expect((await read(late.id)).extraction?.status).toBe('ready');
    });

    it('does not reuse it across owners, types, or a changed service', async () => {
      const mineru: MediaConnection = {
        providerId: 'mineru',
        baseUrl: 'http://mineru-a:8000',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      };
      const asr = { providerId: 'qwen-asr', modelId: 'm', baseUrl: 'https://asr-a' } as never;
      const base: ExtractionServices = { document: mineru, documentStatus: 'configured', asr };
      await upload('a.pdf', { sha: 'same', mime: 'application/pdf' });
      await runNextOwnerMaterialExtraction('worker-a', deps(undefined, base));
      const extractions = [
        // Another owner.
        { upload: { owner: OTHER, mime: 'application/pdf' }, services: base },
        // The same bytes declared as another type (another extractor).
        { upload: { mime: 'text/plain' }, services: base },
        // Only the speech endpoint changed.
        {
          upload: { mime: 'application/pdf' },
          services: { ...base, asr: { ...(asr as object), baseUrl: 'https://asr-b' } as never },
        },
        // Only the document endpoint changed.
        {
          upload: { mime: 'application/pdf' },
          services: { ...base, document: { ...mineru, baseUrl: 'http://mineru-b:8000' } },
        },
        // Only the document service's options changed.
        {
          upload: { mime: 'application/pdf' },
          services: { ...base, document: { ...mineru, options: { backend: 'vlm' } } },
        },
      ];
      for (const [index, entry] of extractions.entries()) {
        await upload(`variant-${index}.pdf`, { sha: 'same', ...entry.upload });
        await runNextOwnerMaterialExtraction('worker-a', deps(undefined, entry.services));
      }
      expect(analyzed).toEqual([
        'a.pdf',
        'variant-0.pdf',
        'variant-1.pdf',
        'variant-2.pdf',
        'variant-3.pdf',
        'variant-4.pdf',
      ]);
      // Credentials alone do not change the identity.
      expect(extractionIdentityKey('application/pdf', base)).toBe(
        extractionIdentityKey('application/pdf', {
          ...base,
          document: { ...mineru, apiKey: 'k2' },
        }),
      );
    });
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
    expect(published(material)).toEqual([]);
    // A failed extraction is not claimed again by itself.
    expect(await runNextOwnerMaterialExtraction('worker-a', deps())).toBe(false);
    expect(await startOwnerMaterialExtractions(pool, OTHER, [material.id], ['failed'])).toEqual([]);
    expect(await startOwnerMaterialExtractions(pool, OWNER, [material.id], ['failed'])).toEqual([
      material.id,
    ]);
    // A running or ready extraction is not restarted.
    expect(
      await startOwnerMaterialExtractions(pool, OWNER, [material.id], ['failed', 'idle']),
    ).toEqual([]);
    await runNextOwnerMaterialExtraction('worker-a', deps());
    expect((await read(material.id)).extraction?.status).toBe('ready');
  });

  describe('leases', () => {
    it('takes an extraction over once its worker stopped heartbeating (a crash)', async () => {
      const material = await upload('crash.pdf');
      // Worker A claims it and dies.
      const dead = await claim('worker-a');
      expect(dead?.material.id).toBe(material.id);
      // A live lease is not taken.
      expect(await claim('worker-b')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Stale after the TTL: a restarted process resumes it.
      expect(await runNextOwnerMaterialExtraction('worker-b', { ...deps(), leaseTtlMs: 50 })).toBe(
        true,
      );
      expect((await read(material.id)).extraction?.status).toBe('ready');
      // The dead attempt's late settlement is refused (the lease is gone).
      expect(
        await settleOwnerMaterialExtraction(pool, material.id, dead!.lease, { status: 'failed' }),
      ).toBe(false);
    });

    it('keeps the published result when a stale attempt finishes after the one that took over', async () => {
      const material = await upload('overlap.pdf');
      // Attempt A runs, stalls past its lease, and is taken over by attempt B
      // of the SAME worker id (one process re-claiming its own stale lease).
      const stalled = gate();
      const started = gate();
      const first = await claim('worker-a');
      const slow = runClaimedOwnerMaterialExtraction(first!, {
        ...deps(async () => {
          started.release();
          await stalled.promise;
          return parsed('stale attempt');
        }),
        // No heartbeat while it stalls: its lease goes stale.
        heartbeatIntervalMs: 60_000,
      });
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = await claim('worker-a', { leaseTtlMs: 50 });
      expect(second?.material.id).toBe(material.id);
      expect(second!.lease).not.toBe(first!.lease);
      await runClaimedOwnerMaterialExtraction(
        second!,
        deps(async () => parsed('fresh attempt')),
      );
      const winner = (await read(material.id)).extraction!;
      expect(winner.status).toBe('ready');

      // A now finishes, writes its own object, loses the settle, and deletes
      // only that object.
      stalled.release();
      await slow;
      expect((await read(material.id)).extraction).toEqual(winner);
      expect(published(material)).toEqual([winner.resultKey]);
      expect(JSON.parse(bytes.objects.get(winner.resultKey!)!.toString('utf8')).text).toBe(
        'fresh attempt',
      );
    });

    it('never re-claims a material this process extracts', async () => {
      const material = await upload('mine.pdf');
      expect((await claim('worker-a'))?.material.id).toBe(material.id);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await claim('worker-a', { leaseTtlMs: 50, exclude: [material.id] })).toBeNull();
    });

    it('aborts the extractor when a heartbeat finds the lease gone, and drops its result', async () => {
      const material = await upload('lost.pdf');
      const held = await claim('worker-a');
      let aborted = false;
      const run = runClaimedOwnerMaterialExtraction(held!, {
        ...deps(async (_name, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          aborted = true;
          return parsed('too late');
        }),
        heartbeatIntervalMs: 20,
      });
      // Another attempt takes the lease (a takeover elsewhere).
      await pool.query('UPDATE owner_material SET extraction_worker = $2 WHERE id = $1', [
        material.id,
        'worker-z:other',
      ]);
      await run;
      expect(aborted).toBe(true);
      expect((await read(material.id)).extraction?.status).toBe('extracting');
      expect(published(material)).toEqual([]);
    });
  });

  it('drops an extraction whose material is deleted, cancelling the extractor and holding the slot until it stops', async () => {
    const material = await upload('gone.pdf');
    const started = gate();
    const finished = gate();
    let sawAbort = false;
    let settledAt = 0;
    const job = runNextOwnerMaterialExtraction('worker-a', {
      ...deps(async (_name, signal) => {
        started.release();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        sawAbort = true;
        // The provider call takes a while to unwind after the abort.
        await finished.promise;
        settledAt = Date.now();
        throw new DOMException('Aborted', 'AbortError');
      }),
      heartbeatIntervalMs: 20,
    });
    await started.promise;
    expect(
      await deleteOwnerMaterial(pool, OWNER, material.id, (key) =>
        deleteMaterialObjects(bytes, key),
      ),
    ).toBe(true);
    await expect.poll(() => sawAbort, UNTIL).toBe(true);
    let jobDone = 0;
    void job.then(() => (jobDone = Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The extractor is still unwinding: the job (its slot) is not done.
    expect(jobDone).toBe(0);
    finished.release();
    await job;
    expect(jobDone).toBeGreaterThanOrEqual(settledAt);
    expect(await getOwnerMaterial(pool, OWNER, material.id)).toBeNull();
    expect([...bytes.objects.keys()].filter((key) => key.includes(material.id))).toEqual([]);
  });

  it('times out an extraction at its budget, even when the extractor ignores the signal', async () => {
    const material = await upload('hang.pdf');
    const release = gate();
    const job = runNextOwnerMaterialExtraction('worker-a', {
      ...deps(async () => {
        await release.promise;
        return parsed('finished anyway');
      }),
      deadlineMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    release.release();
    await job;
    expect((await read(material.id)).extraction).toMatchObject({
      status: 'failed',
      errorCode: 'EXTRACTION_TIMEOUT',
      retryable: true,
    });
    expect(published(material)).toEqual([]);
  });

  it('takes owners in turns, with at most the per-owner limit running', async () => {
    const a1 = await upload('a1.pdf', { createdAt: 1 });
    await upload('a2.pdf', { createdAt: 2 });
    await upload('a3.pdf', { createdAt: 3 });
    const b1 = await upload('b1.pdf', { owner: OTHER, createdAt: 4 });
    expect((await claim('w', { perOwnerLimit: 1 }))?.material.id).toBe(a1.id);
    // The other owner goes next, though its upload is the newest.
    expect((await claim('w', { perOwnerLimit: 1 }))?.material.id).toBe(b1.id);
    // Both owners are at their limit.
    expect(await claim('w', { perOwnerLimit: 1 })).toBeNull();
    // With room for two each, the owner with fewer running goes first.
    expect((await claim('w', { perOwnerLimit: 2 }))?.material.ownerId).toBe(OWNER);
  });

  describe('the byte quota', () => {
    it('counts stored results against the owner, and fails a result over the cap', async () => {
      const material = await upload('big.txt');
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('z'.repeat(2000))),
      );
      const resultBytes = (await read(material.id)).extraction!.resultBytes!;
      expect(resultBytes).toBeGreaterThan(2000);
      // The upload's 5 bytes and its result count: one more byte than is left is refused.
      await expect(
        registerOwnerMaterial(
          pool,
          {
            id: 'mat_quota',
            ownerId: OWNER,
            kind: 'source',
            mime: 'text/plain',
            bytes: 1_000_000 - 5 - resultBytes + 1,
            ossKey: 'k',
          },
          { maxCount: 100, maxTotalBytes: 1_000_000 },
        ),
      ).rejects.toBeInstanceOf(MaterialQuotaExceededError);

      // A result that would take the owner over its byte quota (checked under
      // the upload lock) fails, and its object goes.
      const full = await upload('full.txt');
      await registerOwnerMaterial(
        pool,
        {
          id: 'mat_filler',
          ownerId: OWNER,
          kind: 'source',
          mime: 'text/plain',
          bytes: agentRuntimeConfig.maxMaterialBytesPerOwner - 5 * 3 - resultBytes - 100,
          ossKey: 'filler',
        },
        { maxCount: 100, maxTotalBytes: agentRuntimeConfig.maxMaterialBytesPerOwner },
      );
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('q'.repeat(500))),
      );
      expect((await read(full.id)).extraction).toMatchObject({
        status: 'failed',
        errorCode: 'MATERIAL_QUOTA_EXCEEDED',
      });
      expect(published(full)).toEqual([]);
      await pool.query("DELETE FROM owner_material WHERE id = 'mat_filler'");

      process.env.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB = '1';
      const huge = await upload('huge.txt');
      await runNextOwnerMaterialExtraction(
        'worker-a',
        deps(async () => parsed('w'.repeat(1024 * 1024 + 1))),
      );
      expect((await read(huge.id)).extraction).toMatchObject({
        status: 'failed',
        errorCode: 'EXTRACTION_RESULT_TOO_LARGE',
      });
      expect(published(huge)).toEqual([]);
    });
  });

  describe('the extractor', () => {
    it('runs at most its concurrency, hands its leases back on stop, and another process resumes them', async () => {
      for (let index = 0; index < 4; index += 1) await upload(`c${index}.pdf`);
      let active = 0;
      let peak = 0;
      const blocked = gate();
      const first = startOwnerMaterialExtractor({
        ...deps(async (name, signal) => {
          active += 1;
          peak = Math.max(peak, active);
          try {
            await Promise.race([
              blocked.promise,
              new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              ),
            ]);
            return parsed(name);
          } finally {
            active -= 1;
          }
        }),
        concurrency: 2,
        limits: { leaseTtlMs: 10_000, perOwnerLimit: 10 },
        scanIntervalMs: 20,
        sweepIntervalMs: 0,
      });
      await expect.poll(() => active, UNTIL).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(peak).toBe(2);
      await first.stop();
      expect(active).toBe(0);
      // Handed back: nothing holds a lease, nothing settled.
      const held = await pool.query(
        "SELECT count(*)::int AS n FROM owner_material WHERE extraction_worker IS NOT NULL OR extraction->>'status' <> 'extracting'",
      );
      expect(held.rows[0].n).toBe(0);

      blocked.release();
      const second = startOwnerMaterialExtractor({
        ...deps(),
        concurrency: 2,
        limits: { leaseTtlMs: 10_000, perOwnerLimit: 10 },
        scanIntervalMs: 20,
        sweepIntervalMs: 0,
      });
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM owner_material WHERE extraction->>'status' = 'ready'",
              )
            ).rows[0].n,
          UNTIL,
        )
        .toBe(4);
      await second.stop();
    });
  });

  describe('the sweep of unused uploads', () => {
    it('counts age from the last time the owner read the material back', async () => {
      const old = Date.now() - 48 * 60 * 60 * 1000;
      const held = await upload('held.pdf', { createdAt: old });
      const dropped = await upload('dropped.pdf', { createdAt: old });
      // A composer that holds it reads it back (GET /api/materials/{id}).
      expect((await touchOwnerMaterial(pool, OWNER, held.id))?.id).toBe(held.id);
      expect(await touchOwnerMaterial(pool, OTHER, held.id)).toBeNull();
      const swept = await sweepUnusedOwnerMaterialsNow(bytes);
      expect(swept).toMatchObject({ marked: 1, removed: 1 });
      expect(await getOwnerMaterial(pool, OWNER, held.id)).not.toBeNull();
      expect(await getOwnerMaterial(pool, OWNER, dropped.id)).toBeNull();
    });

    it('deletes unpublished result objects once no attempt can still settle them', async () => {
      const material = await upload('orphans.pdf');
      await runNextOwnerMaterialExtraction('worker-a', deps());
      const publishedKey = (await read(material.id)).extraction!.resultKey!;
      const prefix = materialExtractionResultPrefix(material.ossKey);
      const longAgo = Date.now() - orphanResultAgeMs() - 1000;
      // A crashed attempt's result, a broken-off write, and a live attempt's result.
      await bytes.put(`${prefix}crashed.json`, Buffer.from('{}'));
      await bytes.put(`${prefix}crashed.json.123.tmp`, Buffer.from('{'));
      await bytes.put(`${prefix}live.json`, Buffer.from('{}'));
      bytes.modifiedAt.set(`${prefix}crashed.json`, longAgo);
      bytes.modifiedAt.set(`${prefix}crashed.json.123.tmp`, longAgo);
      bytes.modifiedAt.set(publishedKey, longAgo);
      expect((await sweepUnusedOwnerMaterialsNow(bytes)).orphans).toBe(2);
      expect(published(material).sort()).toEqual([publishedKey, `${prefix}live.json`].sort());
    });

    it('deletes old uploads nothing references, keeps used and recent ones, and finishes released ones', async () => {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, input JSONB NOT NULL)',
      );
      await pool.query(
        'CREATE TABLE IF NOT EXISTS agent_session_materials (id TEXT PRIMARY KEY, owner_material_id TEXT)',
      );
      try {
        const old = Date.now() - 48 * 60 * 60 * 1000;
        const unused = await upload('unused.pdf', { createdAt: old });
        await runNextOwnerMaterialExtraction('worker-a', deps());
        const usedByRun = await upload('run.pdf', { createdAt: old });
        const usedBySession = await upload('session.pdf', { createdAt: old });
        const recent = await upload('recent.pdf');
        const released = await upload('released.pdf');
        await pool.query(`INSERT INTO generation_runs (id, input) VALUES ('run-1', $1)`, [
          JSON.stringify({ materialIds: [usedByRun.id] }),
        ]);
        await pool.query(
          `INSERT INTO agent_session_materials (id, owner_material_id) VALUES ('s-1', $1)`,
          [usedBySession.id],
        );
        await pool.query('UPDATE owner_material SET deleted_at = $2 WHERE id = $1', [
          released.id,
          Date.now(),
        ]);

        expect(await sweepUnusedOwnerMaterialsNow(bytes)).toMatchObject({ marked: 1, removed: 2 });
        const left = await pool.query<{ id: string }>('SELECT id FROM owner_material ORDER BY id');
        expect(left.rows.map((row) => row.id).sort()).toEqual(
          [usedByRun.id, usedBySession.id, recent.id].sort(),
        );
        for (const gone of [unused, released]) {
          expect([...bytes.objects.keys()].filter((key) => key.includes(gone.id))).toEqual([]);
        }
        expect(bytes.objects.has(usedByRun.ossKey)).toBe(true);
      } finally {
        await pool.query('DROP TABLE generation_runs');
        await pool.query('DROP TABLE agent_session_materials');
      }
    });
  });

  describe('a run reading the materials', () => {
    let extractor: ReturnType<typeof startOwnerMaterialExtractor> | null = null;
    afterEach(async () => {
      await extractor?.stop();
      extractor = null;
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
      extractor = startOwnerMaterialExtractor({
        ...deps(async (name) => parsed(`${name} text`)),
        sweepIntervalMs: 0,
      });
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

    it('produces exactly what extracting during the run produced', async () => {
      // The material analysis as runs did it before extraction at upload:
      // each material parsed, its part built off the parse, bundled.
      const contents = [parsed('first [img_1] text', 2), parsed('second [img_2] body', 3)];
      const names = ['one.pdf', 'two.pdf'];
      const materials = [];
      for (const [index, name] of names.entries()) {
        materials.push(await upload(name, { mime: 'application/pdf' }));
        await runNextOwnerMaterialExtraction(
          'worker-a',
          deps(async () => contents[index]!),
        );
      }
      const parts: ParsedDocumentPart[] = materials.map((record, order) => {
        const content = contents[order]!;
        return {
          source: {
            id: record.id,
            name: names[order]!,
            size: record.bytes,
            mimeType: 'application/pdf',
            order,
          },
          text: content.text,
          rawTextLength: content.text.length,
          pageCount: content.metadata!.pageCount,
          images: content.metadata!.pdfImages!.map((image) => ({
            id: image.id,
            src: image.src || '',
            pageNumber: image.pageNumber ?? 1,
            description: image.description,
            width: image.width,
            height: image.height,
          })),
        };
      });
      const bundle = buildDocumentBundle(parts);
      const expected = {
        text: bundle.text,
        images: bundle.images.map(({ src, ...image }) => {
          const decoded = decodeDataUrl(src, 50 * 1024 * 1024);
          return { ...image, bytes: decoded.bytes, mimeType: decoded.mimeType };
        }),
      };
      const actual = await defaultRunStepServices.analyzeMaterials(
        OWNER,
        materials.map((record) => record.id),
        { log: console as never },
      );
      expect(actual.text).toBe(expected.text);
      expect(actual.images.map((image) => ({ ...image, bytes: Buffer.from(image.bytes) }))).toEqual(
        expected.images.map((image) => ({ ...image, bytes: Buffer.from(image.bytes) })),
      );
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

    it('waits without a deadline while queued, and times out a claimed extraction past its budget', async () => {
      const queued = await upload('queued.txt');
      const abort = new AbortController();
      const waiting = awaitOwnerMaterialExtractions([queued], abort.signal, {
        pollMs: 10,
        deadlineMs: 20,
      });
      // Well past the budget, still waiting: nobody runs it yet.
      await new Promise((resolve) => setTimeout(resolve, 150));
      abort.abort(new Error('run stopped'));
      await expect(waiting).rejects.toThrow('run stopped');

      // Claimed long ago by a worker that never finishes.
      await claim('worker-a');
      await pool.query(
        "UPDATE owner_material SET extraction = extraction || jsonb_build_object('claimedAt', $2::double precision) WHERE id = $1",
        [queued.id, Date.now() - 60 * 60 * 1000],
      );
      await expect(
        awaitOwnerMaterialExtractions([await read(queued.id)], undefined, {
          pollMs: 10,
          deadlineMs: 20,
        }),
      ).rejects.toBeInstanceOf(MaterialExtractionTimeoutError);
    });
  });
});
