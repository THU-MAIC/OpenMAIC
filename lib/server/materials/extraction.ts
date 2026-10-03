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
  getOwnerMaterial,
  getReadyOwnerMaterials,
  heartbeatOwnerMaterialExtraction,
  materialMediaKind,
  releaseOwnerMaterialExtraction,
  settleOwnerMaterialExtraction,
  startOwnerMaterialExtractions,
  type OwnerMaterialExtraction,
  type OwnerMaterialRecord,
  type OwnerMaterialTruncation,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { ClassroomMaterialsUnavailableError } from '@/lib/server/classroom-materials';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { STEP_DEADLINES_MS, withDeadline } from '@/lib/server/generation/run/deadline';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { analyzeMaterial } from '@/lib/server/generation/steps/material-analysis';
import { isTransientExtractionError } from '@/lib/server/material-extraction/errors';
import {
  resolveExtractionServices,
  type ExtractionServices,
} from '@/lib/server/material-extraction/services';
import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import type { ParsedPdfContent } from '@/lib/types/pdf';

import { getMaterialByteStore, materialExtractionResultKey, type MaterialByteStore } from './bytes';
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

/**
 * Which services an extraction ran with: a ready extraction of the same
 * bytes is reused only under the same ones (the owner may have switched the
 * document service to get a better extraction).
 */
export function extractionServicesKey(services: ExtractionServices): string {
  return JSON.stringify([
    services.documentStatus ?? null,
    services.document?.providerId ?? null,
    services.document?.baseUrl ?? null,
    services.asr?.providerId ?? null,
    services.asr?.modelId ?? null,
  ]);
}

export async function readMaterialExtractionResult(
  ossKey: string,
  byteStore: MaterialByteStore = getMaterialByteStore(),
): Promise<MaterialExtractionResult> {
  const raw = await byteStore.get(materialExtractionResultKey(ossKey));
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

/**
 * Extract one material (or reuse a ready extraction of the same bytes) and
 * store its result. Answers the material's `ready` extraction; throws the
 * extraction's failure.
 */
export async function extractOwnerMaterial(
  material: OwnerMaterialRecord,
  signal: AbortSignal,
  dependencies: MaterialExtractionDependencies = {},
): Promise<OwnerMaterialExtraction> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  const services = await (dependencies.services ?? ownerExtractionServices)(material.ownerId);
  const servicesKey = extractionServicesKey(services);
  const resultKey = materialExtractionResultKey(material.ossKey);

  const reusable = await findReusableOwnerMaterialExtraction(pool, material, servicesKey);
  if (reusable?.extraction) {
    try {
      const copied = await byteStore.get(materialExtractionResultKey(reusable.ossKey));
      await byteStore.put(resultKey, copied, 'application/json');
      const { updatedAt: _updatedAt, ...extraction } = reusable.extraction;
      log.info(`material ${material.id}: reused the extraction of ${reusable.id}`);
      return extraction;
    } catch (error) {
      // The other material went in between: extract these bytes after all.
      log.warn(`material ${material.id}: reusing ${reusable.id} failed; extracting`, error);
    }
  }

  const fileName = material.originalName ?? material.id;
  const parsed = await withDeadline(
    `material ${material.id}`,
    dependencies.deadlineMs ?? STEP_DEADLINES_MS.materialAnalysis,
    signal,
    async (callSignal) =>
      (dependencies.analyze ?? analyzeMaterial)(
        {
          source: {
            fileName,
            fileSize: material.bytes,
            mimeType: normalizeDocumentMimeType({ mimeType: material.mime, fileName }),
            buffer: await byteStore.get(material.ossKey),
          },
          services,
          request: {},
          redactCallerInput: false,
        },
        { log, signal: callSignal },
      ),
  );
  const result = resultOf(parsed);
  await byteStore.put(resultKey, Buffer.from(JSON.stringify(result), 'utf8'), 'application/json');
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
    servicesKey,
  };
}

/** The failed extraction a failure leaves: its message, kind and whether trying again may help. */
export function failedExtraction(error: unknown): OwnerMaterialExtraction {
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    errorCode: error instanceof StepRefusal ? error.reason : 'EXTRACTION_FAILED',
    retryable: isTransientExtractionError(error),
  };
}

interface ExtractionLeaseOptions extends MaterialExtractionDependencies {
  heartbeatIntervalMs: number;
  /** Aborted when the process stops: the lease is handed back for a takeover. */
  signal?: AbortSignal;
}

/** Run one claimed material's extraction under a heartbeat, and settle it. */
export async function runClaimedOwnerMaterialExtraction(
  material: OwnerMaterialRecord,
  workerId: string,
  options: ExtractionLeaseOptions,
): Promise<void> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const byteStore = options.byteStore ?? getMaterialByteStore();
  const lost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal;
  const heartbeat = setInterval(() => {
    void heartbeatOwnerMaterialExtraction(pool, material.id, workerId)
      .then((held) => {
        // Deleted, or taken over: the work is dropped.
        if (!held) lost.abort();
      })
      .catch((error) => log.warn(`material ${material.id}: heartbeat failed`, error));
  }, options.heartbeatIntervalMs);
  heartbeat.unref?.();
  let extraction: OwnerMaterialExtraction;
  try {
    extraction = await extractOwnerMaterial(material, signal, { ...options, byteStore });
  } catch (error) {
    if (lost.signal.aborted) {
      log.info(`material ${material.id}: extraction dropped (deleted or taken over)`);
      return;
    }
    if (signal.aborted) {
      // Stopping: the next process (or this one, restarted) resumes it.
      await releaseOwnerMaterialExtraction(pool, material.id, workerId);
      return;
    }
    log.warn(`material ${material.id}: extraction failed`, error);
    await settleOwnerMaterialExtraction(pool, material.id, workerId, failedExtraction(error));
    return;
  } finally {
    clearInterval(heartbeat);
  }
  const settled = await settleOwnerMaterialExtraction(pool, material.id, workerId, extraction);
  if (settled) {
    log.info(
      `material ${material.id} (${materialMediaKind(material.mime)}): extracted ` +
        `${extraction.textChars ?? 0} chars, ${extraction.imageCount ?? 0} images`,
    );
  } else if (!(await getOwnerMaterial(pool, material.ownerId, material.id))) {
    // Deleted while it was extracted: its delete may have run before the
    // result was written, so the result goes now.
    await byteStore
      .delete(materialExtractionResultKey(material.ossKey))
      .catch((error) => log.warn(`material ${material.id}: result cleanup failed`, error));
  }
}

/**
 * Claim one material's extraction and run it to its settlement. False when
 * there was nothing to claim. Exported for the contract tests.
 */
export async function runNextOwnerMaterialExtraction(
  workerId: string,
  options: ExtractionLeaseOptions & { leaseTtlMs: number },
): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const material = await claimOwnerMaterialExtraction(pool, workerId, options.leaseTtlMs);
  if (!material) return false;
  await runClaimedOwnerMaterialExtraction(material, workerId, options);
  return true;
}

/** Extractions one process runs at once. */
export function materialExtractionConcurrency(): number {
  const raw = process.env.OPENMAIC_MATERIAL_EXTRACTION_CONCURRENCY?.trim();
  if (!raw) return 2;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `OPENMAIC_MATERIAL_EXTRACTION_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** Start the process-scoped background extractor of owner materials. */
export function startOwnerMaterialExtractor(
  options: { workerId?: string; concurrency?: number } & MaterialExtractionDependencies = {},
): OwnerMaterialExtractorHandle {
  const workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
  const concurrency = options.concurrency ?? materialExtractionConcurrency();
  const stopping = new AbortController();
  const running = new Set<Promise<void>>();
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
        while (running.size < concurrency && !stopping.signal.aborted) {
          const material = await claimOwnerMaterialExtraction(
            pool,
            workerId,
            agentRuntimeConfig.leaseTtlMs,
          );
          if (!material) break;
          const job: Promise<void> = runClaimedOwnerMaterialExtraction(material, workerId, {
            ...options,
            heartbeatIntervalMs: agentRuntimeConfig.heartbeatIntervalMs,
            signal: stopping.signal,
          })
            .catch((error) => log.error(`material ${material.id}: extraction job failed`, error))
            .finally(() => {
              running.delete(job);
              if (!stopping.signal.aborted) void scan();
            });
          running.add(job);
        }
      } while (rescan && !stopping.signal.aborted);
    } catch (error) {
      log.error('extraction scan failed', error);
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => void scan(), agentRuntimeConfig.scanIntervalMs);
  timer.unref?.();
  void scan();

  const handle: OwnerMaterialExtractorHandle = {
    workerId,
    wake: () => void scan(),
    async stop(stopOptions) {
      stopping.abort();
      unregisterOwnerMaterialExtractor(handle);
      clearInterval(timer);
      const deadline = Date.now() + (stopOptions?.timeoutMs ?? 15_000);
      while ((running.size > 0 || scanning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  registerOwnerMaterialExtractor(handle);
  return handle;
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
 * its error. Polls the rows (`pollMs`) and honours `signal`, which carries the
 * step's deadline.
 */
export async function awaitOwnerMaterialExtractions(
  records: readonly OwnerMaterialRecord[],
  signal: AbortSignal | undefined,
  { pollMs = 500 }: { pollMs?: number } = {},
): Promise<OwnerMaterialRecord[]> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const ids = records.map((record) => record.id);
  const idle = records.filter((record) => (record.extraction?.status ?? 'idle') === 'idle');
  if (idle.length > 0) {
    await startOwnerMaterialExtractions(
      pool,
      idle.map((record) => record.id),
      ['idle'],
    );
    wakeOwnerMaterialExtractor();
  }
  let current = records;
  for (;;) {
    const failed = current.find((record) => record.extraction?.status === 'failed');
    if (failed) throw new MaterialExtractionFailedError(failed.id, failed.extraction!);
    if (current.every((record) => record.extraction?.status === 'ready')) return [...current];
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
    const owner = records[0]!.ownerId;
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
