/**
 * Owner-level extraction of library sources: claim, extract, allocate and
 * publish, on the state in `lib/persistence/owner-material-extraction.ts`.
 *
 * `instrumentation.ts` starts {@link startOwnerExtractionRunner} beside the
 * session runner (`./runner.ts`), which keeps serving copies made before
 * links. `extract_material` queues a library source here; the material tools
 * and every consumer read the results through
 * `lib/server/agent-runtime/material-resolver.ts` (RFC #1716 Phase 2).
 *
 * ## One run
 *
 * 1. Read the source's bytes (`readSource`; by default the asset pool, or the
 *    material byte store for a source from before the pool, see
 *    `readOwnerMaterialBytes`) and choose the extractor.
 * 2. Before each extractor runs -- the preferred one, then each document
 *    fallback in turn -- look for the owner's own earlier result under that
 *    extractor's cache key and, when there is one, publish it for this source
 *    with derivatives of its own. A hit that no longer holds under lock is a
 *    miss.
 * 3. Otherwise extract, then allocate each kept file as a pending pool entry
 *    in its own transaction, then publish everything in one more.
 *
 * Every allocation and the publication check the claim first. A claim that
 * is no longer current when it allocates stores nothing. A run that is
 * refused for certain -- its claim lost, its source deleted, its publication
 * refused -- removes the entries it allocated, which nothing will ever name,
 * so they do not hold the owner's quota for a day; a publication whose
 * outcome is uncertain keeps them, and an entry whose allocation itself
 * failed part-way expires like any unpublished allocation. What
 * this does not do: cancel a provider call (none of them takes a signal) or
 * bound how long one runs. A late result is refused when it tries to publish.
 *
 * Document extraction keeps its text and the images the provider found, as
 * derivatives; the text's references to them name the derivatives
 * (`./document-images.ts`). Media extraction keeps its transcript and its
 * images. The session chain still keeps document text only.
 */
import { createHash, randomUUID } from 'node:crypto';

import { AssetQuotaExceededError } from '@openmaic/storage';
import { AssetRootTargetError } from '@openmaic/storage/asset/pg';

import { asrRequestUrl } from '@/lib/audio/asr-providers';
import { derivedStem, keyframeTitle } from '@/lib/document/extractors/local-media';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import {
  OwnerExtractionClaimLostError,
  checkOwnerExtractionClaim,
  claimNextOwnerMaterialExtraction,
  findOwnerExtractionCacheHit,
  heartbeatOwnerMaterialExtraction,
  publishOwnerMaterialExtraction,
  settleOwnerMaterialExtractionFailure,
  type OwnerExtractionClaim,
  type OwnerExtractionDerivative,
  type OwnerExtractionPublication,
  type OwnerExtractionResult,
  type PublishOutcome,
} from '@/lib/persistence/owner-material-extraction';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import type { ServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getMinerUBackend } from '@/lib/pdf/pdf-providers';
import { DocumentImageParseError } from './document-image-parser';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  OwnerMaterialBytesUnavailableError,
  readOwnerMaterialBytes,
} from '@/lib/server/materials/owner-material-bytes';
import {
  resolveASRBaseUrl,
  resolveASRModel,
  resolvePDFBaseUrl,
  resolveServerASRProviderId,
} from '@/lib/server/provider-config';

import { ownerDocumentOutcome } from './document-images';
import { isTransientExtractionError, MaterialExtractionError } from './errors';
import {
  decodeMediaAssetData,
  documentExtractionFailure,
  documentFailureLine,
  extractWithDocumentProvider,
  planSourceExtraction,
  plannedExtractor,
  runSourceExtraction,
  type ExtractorRegistryDependencies,
  type SourceExtractionOutcome,
  type SourceExtractionPlan,
} from './extract';

/**
 * How long a claim's lease lasts without a heartbeat. Longer than the session
 * chain's 10 seconds because the built-in PDF parser runs on the event loop:
 * a 30.7 MB text PDF held it for 17.7 seconds in one measurement, during
 * which no heartbeat can be sent. That is one sample, not a bound, so this is
 * a mitigation, not a guarantee; the cost is a slower takeover after a crash.
 */
export const OWNER_EXTRACTION_LEASE_TTL_MS = 60_000;
export const OWNER_EXTRACTION_HEARTBEAT_MS = 5_000;

type Persistence = Pick<ServerPersistenceProvider, 'pool' | 'withTransaction' | 'assetStoreIn'>;

export interface OwnerExtractionDependencies extends ExtractorRegistryDependencies {
  persistence: Persistence;
  /** The source's bytes. Where they live changes when uploads move into the pool. */
  readSource?: (claim: OwnerExtractionClaim) => Promise<Buffer>;
  /** The settings besides the extractor version that change its output. */
  resultOptions?: (extractorId: string) => Record<string, string>;
  now?: () => number;
  createId?: () => string;
}

/** Shared between a run and its heartbeat: set once the claim is known to be lost. */
export interface OwnerExtractionRunState {
  lost: boolean;
}

export type OwnerExtractionRunOutcome = PublishOutcome | 'reused';

/** Query parameters that carry credentials: a key changes who pays, not what comes back. */
const CREDENTIAL_QUERY_PARAMS = new Set([
  'access_token',
  'api-key',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'code',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'subscription-key',
  'token',
]);

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A configured endpoint as part of a cache key. Scheme, host and path are
 * kept as they are. The query string can change the result (an
 * `api-version`, a `?model=`), so its other parameters are kept, sorted and
 * only as a digest; credentials, in the user info or in a credential
 * parameter, are dropped. A value that does not parse as a URL is kept only
 * as a digest.
 */
export function endpointIdentity(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    const url = new URL(baseUrl);
    const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    const params = [...url.searchParams]
      .filter(([name]) => !CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase()))
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    return params.length ? `${base}?sha256:${sha256Hex(JSON.stringify(params))}` : base;
  } catch {
    return `sha256:${sha256Hex(baseUrl)}`;
  }
}

/**
 * The server settings that change an extractor's output without changing its
 * version: the endpoint it calls (a self-hosted or overridden service decides
 * the model behind it), the MinerU backend, and for local media the ASR
 * provider, model and endpoint. No credentials: a key changes who pays, not
 * what comes back.
 */
export function defaultResultOptions(extractorId: string): Record<string, string> {
  if (extractorId === 'local-ffmpeg') {
    const asrProvider = resolveServerASRProviderId() ?? '';
    return {
      asrProvider,
      asrModel: (asrProvider && resolveASRModel(asrProvider)) || '',
      asrEndpoint: asrProvider
        ? endpointIdentity(asrRequestUrl(asrProvider, resolveASRBaseUrl(asrProvider)))
        : '',
    };
  }
  const endpoint = endpointIdentity(resolvePDFBaseUrl(extractorId));
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(extractorId === 'mineru' ? { backend: getMinerUBackend() } : {}),
  };
}

/**
 * The owner-scoped cache key (RFC #1716 §3): content identity, the MIME the
 * extraction runs with, the extractor that runs and the settings that change
 * its result. The MIME is part of it because the same bytes can be uploaded
 * under different types and the type decides what is extracted (the plan, and
 * for media whether keyframes are taken). It is used exactly as recorded, as
 * the plan and the extractors read it. The owner is not in the key; a lookup
 * only ever searches the source's own owner. A source without a recorded
 * digest has no reliable content identity and gets no key.
 */
export function ownerExtractionCacheKey(
  source: { sha256: string | null; mime: string },
  extractor: { id: string; version: string },
  options: Record<string, string>,
): string | null {
  if (!source.sha256) return null;
  const settings = Object.entries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(
    JSON.stringify([source.sha256, source.mime, `${extractor.id}@${extractor.version}`, settings]),
  );
}

/**
 * The title of a derivative of the source named `originalName`, from where
 * it sits in the source. Built for the source that publishes it, so a reused
 * derivative is named after its new source, not after the donor.
 */
function derivativeTitle(
  originalName: string | null,
  derivative: { pageNumber?: number; timeMs?: number },
  index: number,
): string {
  const stem = derivedStem(originalName, 'media');
  if (derivative.timeMs !== undefined) return keyframeTitle(stem, derivative.timeMs);
  if (derivative.pageNumber !== undefined) return `${stem} page ${derivative.pageNumber}`;
  return `${stem} image ${index + 1}`;
}

function isQuotaRefusal(error: unknown): boolean {
  if (error instanceof AssetQuotaExceededError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ASSET_QUOTA_EXCEEDED'
  );
}

/**
 * Allocate one file as a pending pool entry for the claim's current owner,
 * in a transaction of its own: the owner fence first (forwarded, as every
 * background write is), then the claim check, then the put.
 */
async function allocate(
  persistence: Persistence,
  claim: OwnerExtractionClaim,
  state: OwnerExtractionRunState,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  if (state.lost) throw new OwnerExtractionClaimLostError(claim.materialId);
  const part = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  try {
    return await persistence.withTransaction(async (tx) => {
      const ownerId = await forwardOwnerWrite(tx, claim.ownerId);
      await checkOwnerExtractionClaim(tx, claim, ownerId);
      return persistence
        .assetStoreIn(tx)
        .put(assetPrincipalForOwner(ownerId), new Blob([part], { type: mime }), {
          contentType: mime,
        });
    });
  } catch (error) {
    if (error instanceof OwnerExtractionClaimLostError) throw error;
    if (isQuotaRefusal(error)) {
      throw new MaterialExtractionError(
        'the asset store has no room for this extraction; free space and start it again',
        false,
        { cause: error, reasonCode: 'storage_full' },
      );
    }
    // The registry reports every other failure without its cause, so a
    // passing database fault cannot be told from a lasting one: retry it,
    // within the claim budget.
    throw new MaterialExtractionError('storing an extraction output failed', true, {
      cause: error,
    });
  }
}

/**
 * The source's original bytes, pool first. The claim's owner is the one the
 * source had when it was claimed; after a claim of that owner the reader finds
 * the source's owner now (see `readOwnerMaterialBytes`).
 */
async function defaultReadSource(claim: OwnerExtractionClaim): Promise<Buffer> {
  return readOwnerMaterialBytes({
    id: claim.materialId,
    ownerId: claim.ownerId,
    assetId: claim.assetId,
    ossKey: claim.ossKey,
    sha256: claim.sha256,
  });
}

/** Run one claimed source to a publication, a refusal, or a thrown failure. */
export async function runClaimedOwnerExtraction(
  claim: OwnerExtractionClaim,
  dependencies: OwnerExtractionDependencies,
  state: OwnerExtractionRunState = { lost: false },
): Promise<OwnerExtractionRunOutcome> {
  const { persistence } = dependencies;
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const resultOptions = dependencies.resultOptions ?? defaultResultOptions;
  const bytes = await (dependencies.readSource ?? defaultReadSource)(claim);
  const mime = claim.mime ?? 'application/octet-stream';
  const source = { sha256: claim.sha256, mime };
  const plan = await planSourceExtraction({ bytes, mime }, claim.originalName, dependencies);

  /**
   * Publish the owner's earlier result of `extractor`, if one still holds.
   * Called before every extractor runs, so a claim known to be lost stops
   * here instead of calling the next provider -- checked again after the
   * lookup, since the heartbeat can find the claim lost while it waits.
   */
  const reuse = async (extractor: {
    id: string;
    version: string;
  }): Promise<OwnerExtractionRunOutcome | undefined> => {
    if (state.lost) return 'not-authorized';
    const key = ownerExtractionCacheKey(source, extractor, resultOptions(extractor.id));
    const hit = key
      ? await findOwnerExtractionCacheHit(persistence.pool, claim.materialId, key)
      : null;
    const reused =
      key && hit ? await publishReused(persistence, claim, key, hit, createId, now()) : 'miss';
    if (reused !== 'miss') return reused;
    return state.lost ? 'not-authorized' : undefined;
  };

  const extracted = await extractOrReuse(plan, claim.originalName, reuse);
  if (extracted.kind === 'reused') return extracted.outcome;
  const outcome = extracted.outcome;

  if (state.lost) return 'not-authorized';
  const options = resultOptions(outcome.extractor.id);
  // Every entry this run allocates, so a run that is refused for certain can
  // remove what nothing will ever name.
  const allocated: string[] = [];
  const derivatives: OwnerExtractionDerivative[] = [];
  let textAssetId: string;
  try {
    const textBytes = Buffer.from(outcome.text, 'utf8');
    textAssetId = await allocate(persistence, claim, state, textBytes, 'text/markdown');
    allocated.push(textAssetId);
    for (const [index, image] of outcome.images.entries()) {
      const imageBytes = decodeMediaAssetData(image.data);
      const assetId = await allocate(persistence, claim, state, imageBytes, image.mimeType);
      allocated.push(assetId);
      derivatives.push({
        id: createId(),
        kind: 'image',
        assetId,
        title: derivativeTitle(claim.originalName, image, index),
        mime: image.mimeType,
        bytes: imageBytes.byteLength,
        sha256: sha256Hex(imageBytes),
        ...(image.pageNumber === undefined ? {} : { pageNumber: image.pageNumber }),
        ...(image.timeMs === undefined ? {} : { timeMs: image.timeMs }),
        ...(image.key === undefined ? {} : { key: image.key }),
      });
    }
  } catch (error) {
    // No publication was attempted: the entries allocated so far are named by
    // nothing and never will be. (The allocation that threw is not among
    // them; whether its entry was stored is not known, so it expires.)
    await releaseAllocations(persistence, claim, allocated);
    throw error;
  }
  if (state.lost) {
    await releaseAllocations(persistence, claim, allocated);
    return 'not-authorized';
  }
  let published: PublishOutcome;
  try {
    published = await publishOwnerMaterialExtraction(
      persistence.withTransaction,
      claim,
      {
        cacheKey: ownerExtractionCacheKey(source, outcome.extractor, options),
        text: {
          assetId: textAssetId,
          chars: outcome.text.length,
          ...(outcome.imageRefs === undefined ? {} : { imageRefs: outcome.imageRefs }),
        },
        extractor: { ...outcome.extractor, options },
        stats: { ...outcome.stats },
        derivatives,
      },
      now(),
    );
  } catch (error) {
    // An entry allocated above is gone or under another owner: the root call
    // refused it before anything committed, so nothing was published, and a
    // fresh claim allocates again.
    if (error instanceof AssetRootTargetError) {
      await releaseAllocations(persistence, claim, allocated);
      throw new MaterialExtractionError('an extraction output is no longer stored', true, {
        cause: error,
      });
    }
    // Any other failure may have committed: the entries stay and expire if
    // nothing names them.
    throw error;
  }
  // A refusal writes nothing, so nothing names these entries.
  if (published !== 'published') await releaseAllocations(persistence, claim, allocated);
  return published;
}

/**
 * Remove entries a run allocated and is certain never to publish -- the
 * claim was lost, the source was deleted, or the publication was refused --
 * so they do not hold the owner's quota until they expire. One transaction,
 * under the owner the claim's source has now (a claim since the allocation
 * moved them to the account). The store refuses to remove an entry a root
 * holds, so this can never take bytes something keeps. A failure only warns:
 * the entries expire like any unpublished allocation.
 */
async function releaseAllocations(
  persistence: Persistence,
  claim: OwnerExtractionClaim,
  assetIds: readonly string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  try {
    await persistence.withTransaction(async (tx) => {
      const ownerId = await forwardOwnerWrite(tx, claim.ownerId);
      const store = persistence.assetStoreIn(tx);
      for (const assetId of assetIds) {
        await store.remove(assetPrincipalForOwner(ownerId), assetId);
      }
    });
  } catch (error) {
    console.warn(
      `[owner-extraction] unpublished outputs of ${claim.materialId} left to expire`,
      error,
    );
  }
}

/**
 * Walk the plan's extractors in their order, trying the owner's earlier
 * result of each one before running it: a document fallback that once
 * succeeded is reused when the providers ahead of it fail, exactly as it
 * would have been run. The failure when every extractor fails is the one the
 * session chain reports.
 */
async function extractOrReuse(
  plan: SourceExtractionPlan,
  title: string | null,
  reuse: (extractor: {
    id: string;
    version: string;
  }) => Promise<OwnerExtractionRunOutcome | undefined>,
): Promise<
  | { kind: 'reused'; outcome: OwnerExtractionRunOutcome }
  | { kind: 'extracted'; outcome: SourceExtractionOutcome }
> {
  if (plan.kind === 'media') {
    const reused = await reuse(plannedExtractor(plan));
    if (reused) return { kind: 'reused', outcome: reused };
    return { kind: 'extracted', outcome: await runSourceExtraction(plan, title) };
  }
  const errors: string[] = [];
  const failures: unknown[] = [];
  for (const provider of plan.candidates) {
    const reused = await reuse({ id: provider.id, version: provider.version });
    if (reused) return { kind: 'reused', outcome: reused };
    try {
      const artifact = await extractWithDocumentProvider(provider, plan.input);
      return { kind: 'extracted', outcome: await ownerDocumentOutcome(artifact, provider) };
    } catch (error) {
      if (error instanceof DocumentImageParseError) throw error;
      errors.push(documentFailureLine(provider, error));
      failures.push(error);
    }
  }
  throw documentExtractionFailure(errors, failures, plan.noServiceConfigured);
}

/**
 * Publish an earlier result of the same owner for this source: the same
 * pool entries, rooted again under this source and derivatives of its own,
 * named after this source.
 * `miss` when the earlier result no longer holds -- its source changed or was
 * deleted, a root it held is withdrawn, or an entry it named is gone -- so
 * the caller extracts instead.
 */
async function publishReused(
  persistence: Persistence,
  claim: OwnerExtractionClaim,
  cacheKey: string,
  hit: { materialId: string; result: OwnerExtractionResult },
  createId: () => string,
  now: number,
): Promise<OwnerExtractionRunOutcome | 'miss'> {
  const publication: OwnerExtractionPublication = {
    cacheKey,
    donor: {
      materialId: hit.materialId,
      revision: hit.result.revision,
      roots: [
        { rootId: hit.materialId, assetId: hit.result.text.assetId },
        ...hit.result.derivatives.map((derivative) => ({
          rootId: derivative.id,
          assetId: derivative.assetId,
        })),
      ],
    },
    text: hit.result.text,
    extractor: hit.result.extractor,
    stats: hit.result.stats,
    derivatives: hit.result.derivatives.map((derivative, index) => ({
      ...derivative,
      id: createId(),
      title: derivativeTitle(claim.originalName, derivative, index),
    })),
  };
  try {
    const outcome = await publishOwnerMaterialExtraction(
      persistence.withTransaction,
      claim,
      publication,
      now,
    );
    if (outcome === 'donor-changed') return 'miss';
    return outcome === 'published' ? 'reused' : outcome;
  } catch (error) {
    if (error instanceof AssetRootTargetError) return 'miss';
    throw error;
  }
}

export interface OwnerExtractionWorkerOptions {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Claim and run one source. `false` when there was nothing to claim. A
 * failure is settled under the claim's token; a claim found lost is not
 * settled, so it can never settle the claim that replaced it.
 */
export async function runNextOwnerExtraction(
  dependencies: OwnerExtractionDependencies,
  options: OwnerExtractionWorkerOptions = {},
): Promise<boolean> {
  const now = dependencies.now ?? Date.now;
  const { pool } = dependencies.persistence;
  const claim = await claimNextOwnerMaterialExtraction(pool, {
    leaseTtlMs: options.leaseTtlMs ?? OWNER_EXTRACTION_LEASE_TTL_MS,
    now: now(),
    createToken: randomUUID,
  });
  if (!claim) return false;
  const state: OwnerExtractionRunState = { lost: false };
  const heartbeat = setInterval(() => {
    heartbeatOwnerMaterialExtraction(pool, claim, now()).then(
      (current) => {
        if (!current) state.lost = true;
      },
      (error) => {
        // A heartbeat that did not land renews nothing; the lease decides.
        console.warn('[owner-extraction] heartbeat failed', error);
      },
    );
  }, options.heartbeatIntervalMs ?? OWNER_EXTRACTION_HEARTBEAT_MS);
  try {
    await runClaimedOwnerExtraction(claim, dependencies, state);
  } catch (error) {
    if (!(error instanceof OwnerExtractionClaimLostError) && !state.lost) {
      await settleOwnerMaterialExtractionFailure(pool, claim, {
        reason: error instanceof Error ? error.message : String(error),
        retryable: isTransientExtractionError(error),
        reasonCode:
          error instanceof OwnerMaterialBytesUnavailableError
            ? 'source_unavailable'
            : error instanceof MaterialExtractionError
              ? error.reasonCode
              : undefined,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export interface OwnerExtractionRunnerHandle {
  /**
   * Stop claiming, then wait for the runs under way, up to `timeoutMs`
   * (default 15 s). `drained: false` means some are still running -- a
   * provider that never returns, say -- and the caller decides what to do;
   * see {@link startOwnerExtractionRunner}.
   */
  stop(options?: { timeoutMs?: number }): Promise<{ drained: boolean; running: number }>;
}

export interface OwnerExtractionRunnerOptions extends OwnerExtractionWorkerOptions {
  /** The run dependencies; by default this deployment's persistence and providers. */
  dependencies?: () => Promise<OwnerExtractionDependencies>;
  scanIntervalMs?: number;
  maxConcurrent?: number;
}

/**
 * Start the process-scoped scanner of owner-level extraction, beside the
 * session chain's (`./runner.ts`): every interval it fills its free slots
 * with {@link runNextOwnerExtraction}. Claims, leases and the claim budget
 * keep several instances from running one source twice; a run whose claim
 * is lost publishes nothing. `stop` stops claiming and waits for the runs
 * under way, so shutdown closes the pool only after them.
 *
 * The wait is bounded, because a provider call cannot be cancelled and may
 * never return, and a shutdown must end. When it runs out, `stop` says so
 * (`drained: false`) instead of pretending the runs finished. A run still
 * going when the pool closes cannot write anything: every write of a run is
 * a transaction of its own that checks its claim, so it fails rather than
 * commits; its lease then expires and another instance claims the source
 * again, within the claim budget, while the stale claim stays refused.
 */
export function startOwnerExtractionRunner(
  options: OwnerExtractionRunnerOptions = {},
): OwnerExtractionRunnerHandle {
  const dependencies =
    options.dependencies ??
    (async (): Promise<OwnerExtractionDependencies> => {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      return { persistence: await getServerPersistenceProvider(process.env.DATABASE_URL ?? '') };
    });
  const scanIntervalMs = options.scanIntervalMs ?? agentRuntimeConfig.scanIntervalMs;
  const maxConcurrent = options.maxConcurrent ?? agentRuntimeConfig.maxConcurrent;
  const running = new Set<Promise<void>>();
  let stopping = false;

  const scan = async () => {
    if (stopping) return;
    try {
      const resolved = await dependencies();
      for (let slot = running.size; !stopping && slot < maxConcurrent; slot += 1) {
        const run: Promise<void> = runNextOwnerExtraction(resolved, options)
          .then(() => undefined)
          .catch((error) => {
            console.error('[owner-extraction] run failed before settlement', error);
          })
          .finally(() => running.delete(run));
        running.add(run);
      }
    } catch (error) {
      console.error('[owner-extraction] scan failed', error);
    }
  };
  const timer = setInterval(() => void scan(), scanIntervalMs);
  void scan();

  return {
    async stop(stopOptions) {
      stopping = true;
      clearInterval(timer);
      const deadline = Date.now() + (stopOptions?.timeoutMs ?? 15_000);
      while (running.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { drained: running.size === 0, running: running.size };
    },
  };
}
