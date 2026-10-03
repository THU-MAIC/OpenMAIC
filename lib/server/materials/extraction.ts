/**
 * Extraction at upload: an owner material's text and images are extracted in
 * the background as soon as it is uploaded (`POST /api/materials`), so a run
 * that uses it later reads the stored result instead of extracting it then.
 *
 * - The state is the material row's `extraction` (`idle → extracting →
 *   ready | failed`, see `lib/persistence/owner-materials.ts`). A worker holds
 *   an `extracting` material under a heartbeat lease, as generation runs are
 *   held: a crash or a restart leaves a lease that goes stale, and the next
 *   scan (of any process) takes the extraction over.
 * - The extraction is the run's own (`analyzeMaterial`, through the owner's
 *   document slot, with the material-analysis step's time budget), so a run
 *   reading the stored result generates exactly what extracting it then
 *   would have.
 * - The result (the text, and the images with their bytes inline) is one
 *   object next to the material's bytes (`materialExtractionResultKey`): it
 *   lives as long as the material and is deleted with it. A run copies the
 *   images into course assets when it uses them, as before, so releasing a
 *   material never touches a course.
 * - The same bytes uploaded again by the same owner reuse a ready extraction
 *   made under the same extraction services (a copy of its result) instead of
 *   extracting them again.
 */
import { randomUUID } from 'node:crypto';

import { buildDocumentBundle, type ParsedDocumentImage } from '@/lib/document/bundle';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { createLogger } from '@/lib/logger';
import {
  claimOwnerMaterialExtraction,
  findReusableOwnerMaterialExtraction,
  getReadyOwnerMaterials,
  heartbeatOwnerMaterialExtraction,
  materialMediaKind,
  releaseOwnerMaterialExtraction,
  settleOwnerMaterialExtraction,
  startOwnerMaterialExtractions,
  sweepUnusedOwnerMaterials,
  type OwnerMaterialExtraction,
  type OwnerMaterialExtractionClaim,
  type OwnerMaterialRecord,
  type OwnerMaterialTruncation,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { ClassroomMaterialsUnavailableError } from '@/lib/server/classroom-materials';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { STEP_DEADLINES_MS } from '@/lib/server/generation/run/deadline';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { analyzeMaterial } from '@/lib/server/generation/steps/material-analysis';
import { isTransientExtractionError } from '@/lib/server/material-extraction/errors';
import {
  resolveExtractionServices,
  type ExtractionServices,
} from '@/lib/server/material-extraction/services';
import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import type { ParsedPdfContent } from '@/lib/types/pdf';

import {
  deleteMaterialObjects,
  getMaterialByteStore,
  materialExtractionResultKey,
  type MaterialByteStore,
} from './bytes';
import {
  registerOwnerMaterialExtractor,
  unregisterOwnerMaterialExtractor,
  wakeOwnerMaterialExtractor,
  type OwnerMaterialExtractorHandle,
} from './extractor-wake';

const log = createLogger('MaterialExtraction');

/** The stored result of one material's extraction: what the run's bundle reads of it. */
export interface MaterialExtractionResult {
  version: 1;
  text: string;
  pageCount?: number;
  /** The images as the extraction found them, each with its bytes as a data URL. */
  images: Array<Omit<ParsedDocumentImage, 'sourceDocumentId'>>;
}

/** The images of a parsed material as the generation preview reads them off the extraction. */
function resultOf(parsed: ParsedPdfContent): MaterialExtractionResult {
  return {
    version: 1,
    text: parsed.text,
    ...(parsed.metadata?.pageCount !== undefined ? { pageCount: parsed.metadata.pageCount } : {}),
    // The extractor's own list, else its bare data URLs.
    images: parsed.metadata?.pdfImages
      ? parsed.metadata.pdfImages.map((image) => ({
          id: image.id,
          src: image.src || '',
          pageNumber: image.pageNumber ?? 1,
          description: image.description,
          width: image.width,
          height: image.height,
        }))
      : (parsed.images ?? []).map((src, index) => ({
          id: `img_${index + 1}`,
          src,
          pageNumber: 1,
        })),
  };
}

/**
 * What a bundle of these parts leaves out: the text over the outline's budget
 * and the images past the vision limit. The run warns about the bundle it
 * generates from; one material's own truncation is this over that material
 * alone.
 */
export function bundleTruncation(
  bundle: Pick<
    ReturnType<typeof buildDocumentBundle>,
    'totalRawTextLength' | 'textContentBudget' | 'totalImageCount'
  >,
): OwnerMaterialTruncation {
  return {
    ...(bundle.totalRawTextLength > bundle.textContentBudget
      ? { textChars: bundle.textContentBudget }
      : {}),
    ...(bundle.totalImageCount > MAX_VISION_IMAGES
      ? { images: { total: bundle.totalImageCount, max: MAX_VISION_IMAGES } }
      : {}),
  };
}

/** The extraction services a material's extraction runs with, for its owner. */
async function ownerExtractionServices(ownerId: string): Promise<ExtractionServices> {
  return resolveExtractionServices(await backgroundWorkspaceId(ownerId));
}

/** A JSON value with its object keys sorted, so equal settings serialize equally. */
function canonical(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/**
 * What picks and runs a material's extractor: its normalized type (which
 * selects a document or a media extractor), the document service (provider,
 * model, endpoint, options, origin) and the speech service (provider, model,
 * endpoint). A ready extraction of the same bytes is reused only under the
 * same identity (the owner may have switched services to get a better
 * extraction). Credentials are left out: they do not change the result.
 */
export function extractionIdentityKey(mimeType: string, services: ExtractionServices): string {
  const document = services.document;
  return JSON.stringify([
    mimeType.toLowerCase(),
    services.documentStatus ?? null,
    document
      ? [
          document.providerId,
          document.modelId ?? null,
          document.baseUrl ?? null,
          document.origin,
          canonical(document.options ?? null),
        ]
      : null,
    services.asr
      ? [services.asr.providerId, services.asr.modelId ?? null, services.asr.baseUrl ?? null]
      : null,
  ]);
}

/** The largest stored result one extraction may produce (its text and images). */
export function maxExtractionResultBytes(): number {
  const raw = process.env.OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB?.trim();
  if (!raw) return 100 * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value * 1024 * 1024;
}

/** An extraction produced more than {@link maxExtractionResultBytes}. */
export class ExtractionResultTooLargeError extends StepRefusal<'EXTRACTION_RESULT_TOO_LARGE'> {
  constructor(bytes: number, maxBytes: number) {
    super(
      'EXTRACTION_RESULT_TOO_LARGE',
      `The extracted text and images take ${Math.ceil(bytes / 1024 / 1024)} MB, more than the ${Math.floor(maxBytes / 1024 / 1024)} MB a material may keep; split the file or reduce its images`,
    );
    this.name = 'ExtractionResultTooLargeError';
  }
}

/** The stored result of a material whose extraction is ready. */
export async function readMaterialExtractionResult(
  material: Pick<OwnerMaterialRecord, 'id' | 'extraction'>,
  byteStore: MaterialByteStore = getMaterialByteStore(),
): Promise<MaterialExtractionResult> {
  const resultKey = material.extraction?.resultKey;
  if (material.extraction?.status !== 'ready' || !resultKey) {
    throw new Error(`Material ${material.id} has no stored extraction`);
  }
  const raw = await byteStore.get(resultKey);
  const result = JSON.parse(raw.toString('utf8')) as MaterialExtractionResult;
  if (result?.version !== 1 || typeof result.text !== 'string' || !Array.isArray(result.images)) {
    throw new Error('The stored material extraction is not readable');
  }
  return result;
}

export interface MaterialExtractionDependencies {
  byteStore?: MaterialByteStore;
  services?: (ownerId: string) => Promise<ExtractionServices>;
  /** The extraction itself (the run's `analyzeMaterial`); replaced by tests. */
  analyze?: typeof analyzeMaterial;
  /** The extraction's time budget: the material-analysis step's. */
  deadlineMs?: number;
}

/** A material's extraction ran out of its time budget. Retryable, like a step timeout. */
export class MaterialExtractionTimeoutError extends Error {
  readonly retryable = true;

  constructor(materialId: string, ms: number) {
    super(`The extraction of material ${materialId} did not finish within ${ms / 1000} s`);
    this.name = 'MaterialExtractionTimeoutError';
  }
}

/**
 * Extract one material (or reuse a ready extraction of the same bytes) and
 * store the result under this attempt's own key. Answers the material's
 * `ready` extraction, which publishes that key; throws the extraction's
 * failure. `onStored` is told the key once the object exists, so a caller
 * that does not publish it can delete it.
 *
 * The extractor gets `signal` (with the time budget folded in) and stops its
 * requests and commands on it; this waits until the extractor has actually
 * settled, so the caller's slot stays taken while provider work is running.
 */
export async function extractOwnerMaterial(
  material: OwnerMaterialRecord,
  attempt: string,
  signal: AbortSignal,
  dependencies: MaterialExtractionDependencies & { onStored?: (key: string) => void } = {},
): Promise<OwnerMaterialExtraction> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  const fileName = material.originalName ?? material.id;
  const mimeType = normalizeDocumentMimeType({ mimeType: material.mime, fileName });
  const services = await (dependencies.services ?? ownerExtractionServices)(material.ownerId);
  const identityKey = extractionIdentityKey(mimeType, services);
  const resultKey = materialExtractionResultKey(material.ossKey, attempt);
  const store = async (bytes: Buffer) => {
    const maxBytes = maxExtractionResultBytes();
    if (bytes.byteLength > maxBytes)
      throw new ExtractionResultTooLargeError(bytes.byteLength, maxBytes);
    dependencies.onStored?.(resultKey);
    await byteStore.put(resultKey, bytes, 'application/json');
    return bytes.byteLength;
  };

  const reusable = await findReusableOwnerMaterialExtraction(pool, material, identityKey);
  if (reusable?.extraction?.resultKey) {
    try {
      const resultBytes = await store(await byteStore.get(reusable.extraction.resultKey));
      const {
        updatedAt: _updatedAt,
        claimedAt: _claimedAt,
        resultKey: _resultKey,
        ...extraction
      } = reusable.extraction;
      log.info(`material ${material.id}: reused the extraction of ${reusable.id}`);
      return { ...extraction, resultKey, resultBytes };
    } catch (error) {
      if (error instanceof ExtractionResultTooLargeError) throw error;
      // The other material went in between: extract these bytes after all.
      log.warn(`material ${material.id}: reusing ${reusable.id} failed; extracting`, error);
    }
  }

  const deadlineMs = dependencies.deadlineMs ?? STEP_DEADLINES_MS.materialAnalysis;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new MaterialExtractionTimeoutError(material.id, deadlineMs)),
    deadlineMs,
  );
  timer.unref?.();
  const callSignal = AbortSignal.any([signal, timeout.signal]);
  let parsed: ParsedPdfContent;
  try {
    parsed = await (dependencies.analyze ?? analyzeMaterial)(
      {
        source: {
          fileName,
          fileSize: material.bytes,
          mimeType,
          buffer: await byteStore.get(material.ossKey),
        },
        services,
        request: {},
        redactCallerInput: false,
      },
      { log, signal: callSignal },
    );
  } catch (error) {
    // Ended by the caller or the budget: say so, not how the extractor broke off.
    if (callSignal.aborted) throw callSignal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  // An extractor that ignored the signal finished anyway: the work is dropped.
  callSignal.throwIfAborted();
  const result = resultOf(parsed);
  const resultBytes = await store(Buffer.from(JSON.stringify(result), 'utf8'));
  const alone = buildDocumentBundle([
    {
      source: {
        id: material.id,
        name: fileName,
        size: material.bytes,
        ...(material.mime ? { mimeType: material.mime } : {}),
        order: 0,
      },
      text: result.text,
      rawTextLength: result.text.length,
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
      images: result.images,
    },
  ]);
  const truncated = bundleTruncation(alone);
  return {
    status: 'ready',
    textChars: result.text.length,
    ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
    imageCount: result.images.length,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    ...(parsed.metadata?.parser ? { extractor: String(parsed.metadata.parser) } : {}),
    identityKey,
    resultKey,
    resultBytes,
  };
}

/** The failed extraction a failure leaves: its message, kind and whether trying again may help. */
export function failedExtraction(error: unknown): OwnerMaterialExtraction {
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    errorCode:
      error instanceof StepRefusal
        ? error.reason
        : error instanceof MaterialExtractionTimeoutError
          ? 'EXTRACTION_TIMEOUT'
          : 'EXTRACTION_FAILED',
    retryable: isTransientExtractionError(error),
  };
}

interface ExtractionLeaseOptions extends MaterialExtractionDependencies {
  heartbeatIntervalMs: number;
  /** Aborted when the process stops: the lease is handed back for a takeover. */
  signal?: AbortSignal;
}

/**
 * Run one claimed extraction under a heartbeat and settle it. A heartbeat
 * that finds the lease gone (the material was deleted, its extraction
 * restarted, or another attempt took it over) aborts the extractor; the
 * attempt then deletes its own result object, never another attempt's.
 */
export async function runClaimedOwnerMaterialExtraction(
  claim: OwnerMaterialExtractionClaim,
  options: ExtractionLeaseOptions,
): Promise<void> {
  const { material, lease, attempt } = claim;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const byteStore = options.byteStore ?? getMaterialByteStore();
  const lost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal;
  const heartbeat = setInterval(() => {
    void heartbeatOwnerMaterialExtraction(pool, material.id, lease)
      .then((held) => {
        if (!held) lost.abort(new Error(`material ${material.id}: extraction lease lost`));
      })
      .catch((error) => log.warn(`material ${material.id}: heartbeat failed`, error));
  }, options.heartbeatIntervalMs);
  heartbeat.unref?.();
  let stored: string | undefined;
  const dropOwnResult = async () => {
    if (!stored) return;
    await byteStore
      .delete(stored)
      .catch((error) => log.warn(`material ${material.id}: result cleanup failed`, error));
  };
  let extraction: OwnerMaterialExtraction;
  try {
    extraction = await extractOwnerMaterial(material, attempt, signal, {
      ...options,
      byteStore,
      onStored: (key) => {
        stored = key;
      },
    });
  } catch (error) {
    await dropOwnResult();
    if (lost.signal.aborted) {
      log.info(`material ${material.id}: extraction dropped (deleted or taken over)`);
      return;
    }
    if (signal.aborted) {
      // Stopping: the next process (or this one, restarted) resumes it.
      await releaseOwnerMaterialExtraction(pool, material.id, lease);
      return;
    }
    log.warn(`material ${material.id}: extraction failed`, error);
    await settleOwnerMaterialExtraction(pool, material.id, lease, failedExtraction(error));
    return;
  } finally {
    clearInterval(heartbeat);
  }
  if (!(await settleOwnerMaterialExtraction(pool, material.id, lease, extraction))) {
    // Another attempt holds it now, or it is gone: this result is nobody's.
    await dropOwnResult();
    log.info(`material ${material.id}: extraction result dropped (lease lost)`);
    return;
  }
  log.info(
    `material ${material.id} (${materialMediaKind(material.mime)}): extracted ` +
      `${extraction.textChars ?? 0} chars, ${extraction.imageCount ?? 0} images`,
  );
}

/** Per-process and per-owner limits of the background extractor. */
export interface ExtractorLimits {
  leaseTtlMs: number;
  perOwnerLimit: number;
}

/** The limits every process applies (the agent runtime's lease timing). */
export function extractorLimits(): ExtractorLimits {
  return { leaseTtlMs: agentRuntimeConfig.leaseTtlMs, perOwnerLimit: perOwnerExtractionLimit() };
}

/**
 * Claim one material's extraction and run it to its settlement. False when
 * there was nothing to claim. Exported for the contract tests.
 */
export async function runNextOwnerMaterialExtraction(
  workerId: string,
  options: ExtractionLeaseOptions & { leaseTtlMs: number; perOwnerLimit?: number },
): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const claim = await claimOwnerMaterialExtraction(pool, workerId, {
    leaseTtlMs: options.leaseTtlMs,
    perOwnerLimit: options.perOwnerLimit ?? perOwnerExtractionLimit(),
  });
  if (!claim) return false;
  await runClaimedOwnerMaterialExtraction(claim, options);
  return true;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** One owner's extractions running at once, across every process. */
export function perOwnerExtractionLimit(): number {
  return positiveIntegerEnv('OPENMAIC_MATERIAL_EXTRACTION_PER_OWNER', 2);
}

/** How long an upload no run or session uses is kept. */
export function unusedMaterialTtlMs(): number {
  return positiveIntegerEnv('OPENMAIC_UNUSED_MATERIAL_TTL_HOURS', 24) * 60 * 60 * 1000;
}

/** Extractions one process runs at once. */
export function materialExtractionConcurrency(): number {
  return positiveIntegerEnv('OPENMAIC_MATERIAL_EXTRACTION_CONCURRENCY', 2);
}

/** Start the process-scoped background extractor of owner materials. */
export function startOwnerMaterialExtractor(
  options: {
    workerId?: string;
    concurrency?: number;
    limits?: Partial<ExtractorLimits>;
    heartbeatIntervalMs?: number;
    scanIntervalMs?: number;
    /** How often unused uploads are swept (default hourly); 0 turns the sweep off. */
    sweepIntervalMs?: number;
  } & MaterialExtractionDependencies = {},
): OwnerMaterialExtractorHandle {
  const workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
  const concurrency = options.concurrency ?? materialExtractionConcurrency();
  const stopping = new AbortController();
  // By material id: a material this process extracts is never claimed by it
  // again (a lease of its own that went stale is left to another process).
  const running = new Map<string, Promise<void>>();
  let scanning = false;
  let rescan = false;

  const scan = async (): Promise<void> => {
    if (stopping.signal.aborted) return;
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescan = false;
        const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
        const limits = { ...extractorLimits(), ...options.limits };
        while (running.size < concurrency && !stopping.signal.aborted) {
          const claim = await claimOwnerMaterialExtraction(pool, workerId, {
            ...limits,
            exclude: [...running.keys()],
          });
          if (!claim) break;
          const id = claim.material.id;
          const job: Promise<void> = runClaimedOwnerMaterialExtraction(claim, {
            ...options,
            heartbeatIntervalMs:
              options.heartbeatIntervalMs ?? agentRuntimeConfig.heartbeatIntervalMs,
            signal: stopping.signal,
          })
            .catch((error) => log.error(`material ${id}: extraction job failed`, error))
            .finally(() => {
              running.delete(id);
              if (!stopping.signal.aborted) void scan();
            });
          running.set(id, job);
        }
      } while (rescan && !stopping.signal.aborted);
    } catch (error) {
      log.error('extraction scan failed', error);
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(
    () => void scan(),
    options.scanIntervalMs ?? agentRuntimeConfig.scanIntervalMs,
  );
  timer.unref?.();
  void scan();

  // Uploads nobody used (an upload whose answer was lost, a composer closed
  // without its cleanup, a start that never happened) are deleted once old.
  const sweepIntervalMs = options.sweepIntervalMs ?? 60 * 60 * 1000;
  const sweep = () =>
    void sweepUnusedOwnerMaterialsNow(options.byteStore).catch((error) =>
      log.warn('unused material sweep failed', error),
    );
  const sweepTimer = sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : null;
  sweepTimer?.unref?.();

  const handle: OwnerMaterialExtractorHandle = {
    workerId,
    wake: () => void scan(),
    async stop(stopOptions) {
      stopping.abort();
      unregisterOwnerMaterialExtractor(handle);
      clearInterval(timer);
      if (sweepTimer) clearInterval(sweepTimer);
      const deadline = Date.now() + (stopOptions?.timeoutMs ?? 15_000);
      while ((running.size > 0 || scanning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  registerOwnerMaterialExtractor(handle);
  return handle;
}

/** One pass of the unused-upload sweep, with this deployment's TTL. */
export async function sweepUnusedOwnerMaterialsNow(
  byteStore: MaterialByteStore = getMaterialByteStore(),
): Promise<{ marked: number; removed: number }> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const swept = await sweepUnusedOwnerMaterials(pool, {
    createdBefore: Date.now() - unusedMaterialTtlMs(),
    deleteObjects: (ossKey) => deleteMaterialObjects(byteStore, ossKey),
  });
  if (swept.marked > 0 || swept.removed > 0) {
    log.info(`swept ${swept.marked} unused material(s), removed ${swept.removed}`);
  }
  return swept;
}

/** A material's extraction failed: the run's material step fails with its error. */
export class MaterialExtractionFailedError extends StepRefusal<string> {
  constructor(
    readonly materialId: string,
    extraction: OwnerMaterialExtraction,
  ) {
    super(extraction.errorCode ?? 'EXTRACTION_FAILED', extraction.error ?? 'Extraction failed');
    this.name = 'MaterialExtractionFailedError';
  }
}

/**
 * Wait until every one of `records` (ready uploads of the run's owner) has a
 * ready extraction, and answer them as they are then. Materials never
 * extracted (`idle`) are started first; one that failed fails the wait with
 * its error. Polls the rows (`pollMs`) and honours `signal` (the run's lease
 * and shutdown). There is no deadline while a material waits in the queue
 * (other owners' extractions may be ahead of it); once a worker claims it, its
 * extraction gets the material-analysis budget (`deadlineMs`, plus a lease's
 * grace for a worker that died), after which the wait fails as a timeout.
 */
export async function awaitOwnerMaterialExtractions(
  records: readonly OwnerMaterialRecord[],
  signal: AbortSignal | undefined,
  {
    pollMs = 500,
    deadlineMs = STEP_DEADLINES_MS.materialAnalysis,
  }: { pollMs?: number; deadlineMs?: number } = {},
): Promise<OwnerMaterialRecord[]> {
  if (records.length === 0) return [];
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const owner = records[0]!.ownerId;
  const ids = records.map((record) => record.id);
  const idle = records.filter((record) => (record.extraction?.status ?? 'idle') === 'idle');
  if (idle.length > 0) {
    await startOwnerMaterialExtractions(
      pool,
      owner,
      idle.map((record) => record.id),
      ['idle'],
    );
    wakeOwnerMaterialExtractor();
  }
  const graceMs = deadlineMs + 2 * agentRuntimeConfig.leaseTtlMs;
  let current = records;
  for (;;) {
    const failed = current.find((record) => record.extraction?.status === 'failed');
    if (failed) throw new MaterialExtractionFailedError(failed.id, failed.extraction!);
    if (current.every((record) => record.extraction?.status === 'ready')) return [...current];
    const overdue = current.find(
      (record) =>
        record.extraction?.status === 'extracting' &&
        record.extraction.claimedAt !== undefined &&
        Date.now() - record.extraction.claimedAt > graceMs,
    );
    if (overdue) throw new MaterialExtractionTimeoutError(overdue.id, deadlineMs);
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, pollMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const found = await getReadyOwnerMaterials(pool, owner, ids);
    const byId = new Map(found.map((record) => [record.id, record]));
    current = ids.map((id) => {
      const record = byId.get(id);
      // Deleted while the run waited on it.
      if (!record) throw new ClassroomMaterialsUnavailableError();
      return record;
    });
  }
}
