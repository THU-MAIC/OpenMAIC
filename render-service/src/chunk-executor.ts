/**
 * Bounded, single-process orchestration for HyperFrames' distributed
 * primitives. The producer owns browser capture and closed-GOP encoding; this
 * module owns the local plan/chunk/assemble lifecycle and its retry contract.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemble as producerAssemble,
  plan as producerPlan,
  renderChunk as producerRenderChunk,
  hashProjectDir,
  type AssembleResult,
  type ChunkResult,
  type DistributedRenderConfig,
  type PlanResult,
} from '@hyperframes/producer/distributed';
import type { RenderOptions, RenderProgress } from './types.js';
import { config } from './config.js';

export const CHUNK_PLAN_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CHUNK_COUNT = 1;
export const DEFAULT_CHUNK_WORKERS = 1;

export type ChunkFailureCode =
  | 'missing_chunk'
  | 'duplicate_chunk'
  | 'stale_chunk'
  | 'mismatched_chunk'
  | 'chunk_execution_failed'
  | 'assembly_failed';

export class ChunkExecutorError extends Error {
  readonly code: ChunkFailureCode;

  constructor(code: ChunkFailureCode, message: string) {
    super(message);
    this.name = 'ChunkExecutorError';
    this.code = code;
  }
}

export interface RenderPlanInput {
  projectDir: string;
  outputPath: string;
  options: RenderOptions;
  /** Number of chunks to produce. A value of one is a valid bounded plan. */
  chunkCount?: number;
  /** Maximum producer capture workers inside one chunk. */
  chunkWorkers?: number;
  /** Maximum chunks rendered at once by this process. */
  maxParallelChunks?: number;
  /** Optional producer chunk-size override. */
  chunkSizeFrames?: number;
  /** Optional producer per-chunk frame ceiling. */
  targetChunkFrames?: number;
  /** Plan output root. Defaults to a sibling of the final output. */
  planDir?: string;
  signal?: AbortSignal;
  runtimeVersions?: { node: string; chromium: string };
}

export interface ImmutableRenderPlan {
  schemaVersion: typeof CHUNK_PLAN_SCHEMA_VERSION;
  planHash: string;
  planDir: string;
  projectDir: string;
  projectHash: string;
  outputPath: string;
  options: RenderOptions;
  chunkCount: number;
  /** Requested fan-out before producer resolves its effective chunk count. */
  requestedChunkCount?: number;
  maxParallelChunks: number;
  chunkWorkers: number;
  chunkSizeFrames?: number;
  targetChunkFrames?: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  format: DistributedRenderConfig['format'];
  producerVersion: string;
  ffmpegVersion: string;
  nodeVersion: string;
  chromiumVersion: string;
  captureMode: string;
  assets: readonly PlanAsset[];
  fonts: readonly PlanAsset[];
  runtime: Readonly<Record<string, string>>;
  chunks: readonly ImmutableChunk[];
}

export interface PlanAsset {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ImmutableChunk {
  index: number;
  startFrame: number;
  endFrame: number;
  outputPath: string;
  sha256?: string;
  framesEncoded?: number;
  status: 'pending' | 'running' | 'succeeded';
}

export interface ChunkExecutorDependencies {
  plan?: typeof producerPlan;
  renderChunk?: typeof producerRenderChunk;
  assemble?: typeof producerAssemble;
  /** Read an existing chunk result sidecar. Injectable for failure tests. */
  readChunkResult?: (path: string) => Promise<ChunkSidecar | null>;
  /** Per-process sleep hook, useful for deterministic retry tests. */
  onChunkStarted?: (index: number) => void | Promise<void>;
}

export interface ChunkExecutionRequest {
  projectDir: string;
  outputPath: string;
  options: RenderOptions;
  chunkCount?: number;
  chunkWorkers?: number;
  maxParallelChunks?: number;
  chunkSizeFrames?: number;
  targetChunkFrames?: number;
  planDir?: string;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void | Promise<void>;
  runtimeVersions?: { node: string; chromium: string };
}

export interface ChunkExecutionResult {
  plan: ImmutableRenderPlan;
  assembly: AssembleResult;
  chunks: readonly (ChunkResult & { captureMode?: string })[];
  totalElapsedMs: number;
  stages: { planMs: number; chunksMs: number; assembleMs: number };
}

interface PlanEnvelope {
  schemaVersion: typeof CHUNK_PLAN_SCHEMA_VERSION;
  input: {
    projectDir: string;
    projectHash: string;
    outputPath: string;
    options: RenderOptions;
    chunkWorkers: number;
    maxParallelChunks: number;
    requestedChunkCount?: number;
    chunkSizeFrames?: number;
    targetChunkFrames?: number;
    runtimeVersions: { node: string; chromium: string };
  };
  producer: PlanResult;
  chunks: readonly ImmutableChunk[];
  assets: readonly PlanAsset[];
  fonts: readonly PlanAsset[];
  runtime: Readonly<Record<string, string>>;
  planHash: string;
  localFingerprint?: string;
}

const defaultDeps: Required<Pick<ChunkExecutorDependencies, 'plan' | 'renderChunk' | 'assemble'>> =
  {
    plan: producerPlan,
    renderChunk: producerRenderChunk,
    assemble: producerAssemble,
  };

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return result;
}

function profileBoundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const result = positiveInteger(value, fallback, name);
  if (result > maximum) {
    throw new TypeError(`${name} must be <= ${maximum} for ${config.resourceProfile.name}`);
  }
  return result;
}

async function settleProducer<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  // The producer distributed API has no cancellation parameter. Await it to settle before
  // releasing the coordinator slot or cleaning the plan directory.
  const result = await operation;
  if (signal?.aborted) throw new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
  return result;
}

function terminateChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function renderChunkInTerminatedProcess(
  planDir: string,
  chunkIndex: number,
  outputPath: string,
  signal?: AbortSignal,
  workerPath = fileURLToPath(new URL('./chunk-worker.ts', import.meta.url)),
): Promise<ChunkResult> {
  const child = fork(workerPath, [], {
    detached: true,
    execArgv: ['--import', 'tsx/esm'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let aborting = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (child.connected) {
        try {
          child.disconnect();
        } catch {
          // SIGKILL may close IPC between the connected check and disconnect.
        }
      }
      callback();
    };
    const onAbort = (): void => {
      aborting = true;
      terminateChild(child);
    };
    child.once('error', (error) =>
      finish(() =>
        rejectResult(
          aborting ? new ChunkExecutorError('chunk_execution_failed', 'Render cancelled') : error,
        ),
      ),
    );
    child.once('exit', (code) => {
      if (aborting) {
        finish(() =>
          rejectResult(new ChunkExecutorError('chunk_execution_failed', 'Render cancelled')),
        );
        return;
      }
      if (!settled && code !== 0)
        finish(() => rejectResult(new Error(`Chunk worker exited with code ${code}`)));
    });
    child.on('message', (message: { ok: boolean; result?: ChunkResult; error?: string }) => {
      if (message.ok && message.result) finish(() => resolveResult(message.result!));
      else finish(() => rejectResult(new Error(message.error ?? 'Chunk worker failed')));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.send({ planDir, chunkIndex, outputPath });
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readCompositionDimensions(
  projectDir: string,
): Promise<{ width: number; height: number }> {
  try {
    const html = await readFile(join(projectDir, 'index.html'), 'utf8');
    const root = html.match(/data-composition-id=[^>]*data-width="(\d+)"[^>]*data-height="(\d+)"/i);
    if (root) return { width: Number(root[1]), height: Number(root[2]) };
    const width = html.match(/data-width="(\d+)"/i)?.[1];
    const height = html.match(/data-height="(\d+)"/i)?.[1];
    if (width && height) return { width: Number(width), height: Number(height) };
  } catch {
    // Producer will report a precise missing/invalid project error.
  }
  return { width: 1920, height: 1080 };
}

async function outputDigest(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new ChunkExecutorError('missing_chunk', `Chunk output is missing: ${path}`);
  if (info.isFile()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const parts: string[] = [];
  for (const name of names) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(path, name))) hash.update(chunk);
    parts.push(`${name}\0${hash.digest('hex')}`);
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

async function collectPlanAssets(planDir: string): Promise<PlanAsset[]> {
  const root = join(planDir, 'compiled');
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root);
  const assets: PlanAsset[] = [];
  for (const path of files.sort()) {
    const bytes = await readFile(path);
    assets.push({
      path: path
        .slice(root.length + 1)
        .split('\\')
        .join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    });
  }
  return assets;
}

async function readPlanRuntime(planDir: string): Promise<Readonly<Record<string, string>>> {
  try {
    const encoder = JSON.parse(await readFile(join(planDir, 'meta', 'encoder.json'), 'utf8')) as {
      runtimeEnv?: Record<string, string>;
    };
    return Object.freeze({ ...(encoder.runtimeEnv ?? {}) });
  } catch {
    return Object.freeze({});
  }
}

async function readPlanCaptureMode(planDir: string): Promise<string> {
  try {
    const encoder = JSON.parse(await readFile(join(planDir, 'meta', 'encoder.json'), 'utf8')) as {
      captureMode?: string;
    };
    return encoder.captureMode ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function chunkPath(
  planDir: string,
  index: number,
  format: DistributedRenderConfig['format'],
): string {
  const extension =
    format === 'mp4' ? 'mp4' : format === 'mov' ? 'mov' : format === 'webm' ? 'webm' : 'frames';
  return join(`${resolve(planDir)}.chunks`, `${String(index).padStart(6, '0')}.${extension}`);
}

// The producer fingerprints every file inside planDir. Keep the executor's
// local cache envelope beside the producer plan so it cannot invalidate the
// producer's immutable plan hash.
function localPlanPath(planDir: string): string {
  return `${resolve(planDir)}.local.json`;
}

function assertPlanDirectory(planDir: string, projectDir: string): void {
  const plan = resolve(planDir);
  const project = resolve(projectDir);
  if (plan === project || plan.startsWith(`${project}/`)) {
    throw new TypeError('planDir must not be inside projectDir');
  }
}

type ChunkSidecar = ChunkResult & { planHash?: string; captureMode?: string };

async function defaultReadChunkResult(path: string): Promise<ChunkSidecar | null> {
  try {
    const sidecarPath = path.endsWith('.perf.json') ? path : `${path}.perf.json`;
    const raw = JSON.parse(await readFile(sidecarPath, 'utf8')) as ChunkSidecar;
    // Producer perf sidecars intentionally omit filesystem-specific paths.
    // Reattach the paths from the sidecar location so completed chunks can be
    // reused across retries without weakening output identity checks.
    const outputPath = sidecarPath.endsWith('.perf.json')
      ? sidecarPath.slice(0, -'.perf.json'.length)
      : path;
    return {
      ...raw,
      outputPath: raw.outputPath ?? outputPath,
      perfPath: raw.perfPath ?? sidecarPath,
    };
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function removeOutput(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await rm(`${path}.perf.json`, { force: true });
}

async function verifyChunkOutput(
  chunk: ImmutableChunk,
  planHash: string,
  result: ChunkResult,
): Promise<void> {
  if (result.outputPath !== chunk.outputPath) {
    throw new ChunkExecutorError(
      'mismatched_chunk',
      `Chunk ${chunk.index} returned ${result.outputPath}; expected ${chunk.outputPath}`,
    );
  }
  if (result.framesEncoded !== chunk.endFrame - chunk.startFrame) {
    throw new ChunkExecutorError(
      'mismatched_chunk',
      `Chunk ${chunk.index} encoded ${result.framesEncoded} frames; expected ${chunk.endFrame - chunk.startFrame}`,
    );
  }
  const actualSha256 = await outputDigest(chunk.outputPath);
  if (actualSha256 !== result.sha256) {
    throw new ChunkExecutorError(
      'mismatched_chunk',
      `Chunk ${chunk.index} hash mismatch: result=${result.sha256}, actual=${actualSha256}`,
    );
  }
  const sidecar = await defaultReadChunkResult(chunk.outputPath);
  if (!sidecar || sidecar.sha256 !== result.sha256 || sidecar.planHash !== planHash) {
    throw new ChunkExecutorError(
      'stale_chunk',
      `Chunk ${chunk.index} has no matching plan/hash sidecar for plan ${planHash}`,
    );
  }
  const allowedCaptureModes =
    config.resourceProfile.capturePolicy === 'screenshot-only'
      ? new Set(['screenshot'])
      : new Set(['beginframe', 'screenshot']);
  if (sidecar.captureMode !== undefined && !allowedCaptureModes.has(sidecar.captureMode)) {
    throw new ChunkExecutorError(
      'mismatched_chunk',
      `Chunk ${chunk.index} used capture mode ${sidecar.captureMode}; ` +
        `profile policy is ${config.resourceProfile.capturePolicy}`,
    );
  }
}

function toDistributedConfig(
  options: RenderOptions,
  dimensions: { width: number; height: number },
  input: Pick<ChunkExecutionRequest, 'chunkSizeFrames' | 'maxParallelChunks' | 'targetChunkFrames'>,
): DistributedRenderConfig {
  return {
    fps: options.fps as 24 | 30 | 60,
    width: dimensions.width,
    height: dimensions.height,
    format: options.format,
    quality: options.quality,
    chunkSize: input.chunkSizeFrames,
    maxParallelChunks: input.maxParallelChunks,
    targetChunkFrames: input.targetChunkFrames,
    hdrMode: 'force-sdr',
    rejectOnSystemFonts: true,
    failClosedFontFetch: true,
  };
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  let firstError: unknown;
  const run = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        firstError ??= new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
        return;
      }
      if (firstError !== undefined) return;
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      try {
        await worker(value);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => run());
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

export function freezeRenderPlan(
  envelope: Omit<PlanEnvelope, 'planHash' | 'localFingerprint'>,
): ImmutableRenderPlan {
  const planHash = envelope.producer.planHash;
  return Object.freeze({
    schemaVersion: envelope.schemaVersion,
    planHash,
    planDir: envelope.producer.planDir,
    projectDir: envelope.input.projectDir,
    projectHash: envelope.input.projectHash,
    outputPath: envelope.input.outputPath,
    options: Object.freeze({ ...envelope.input.options }),
    chunkCount: envelope.producer.chunkCount,
    ...(envelope.input.requestedChunkCount !== undefined
      ? { requestedChunkCount: envelope.input.requestedChunkCount }
      : {}),
    maxParallelChunks: envelope.input.maxParallelChunks,
    chunkWorkers: envelope.input.chunkWorkers,
    ...(envelope.input.chunkSizeFrames ? { chunkSizeFrames: envelope.input.chunkSizeFrames } : {}),
    ...(envelope.input.targetChunkFrames
      ? { targetChunkFrames: envelope.input.targetChunkFrames }
      : {}),
    totalFrames: envelope.producer.totalFrames,
    fps: envelope.producer.fps,
    width: envelope.producer.width,
    height: envelope.producer.height,
    format: envelope.producer.format,
    producerVersion: envelope.producer.producerVersion,
    ffmpegVersion: envelope.producer.ffmpegVersion,
    nodeVersion: envelope.input.runtimeVersions.node,
    chromiumVersion: envelope.input.runtimeVersions.chromium,
    captureMode: envelope.runtime.captureMode ?? 'unknown',
    assets: Object.freeze(envelope.assets.map((asset) => Object.freeze({ ...asset }))),
    fonts: Object.freeze(envelope.fonts.map((asset) => Object.freeze({ ...asset }))),
    runtime: Object.freeze({ ...envelope.runtime }),
    chunks: Object.freeze(envelope.chunks.map((chunk) => Object.freeze({ ...chunk }))),
  });
}

export async function createRenderPlan(
  request: RenderPlanInput,
  dependencies: ChunkExecutorDependencies = {},
): Promise<ImmutableRenderPlan> {
  const chunkWorkers = profileBoundedInteger(
    request.chunkWorkers,
    DEFAULT_CHUNK_WORKERS,
    'chunkWorkers',
    config.resourceProfile.maxChunkWorkers,
  );
  const maxParallelChunks = profileBoundedInteger(
    request.maxParallelChunks,
    request.chunkCount ?? DEFAULT_CHUNK_COUNT,
    'maxParallelChunks',
    config.resourceProfile.maxParallelChunks,
  );
  const chunkCount = positiveInteger(request.chunkCount, maxParallelChunks, 'chunkCount');
  const runtimeVersions = request.runtimeVersions ?? {
    node: process.version,
    chromium: process.env.PRODUCER_EXPECTED_CHROMIUM_MAJOR ?? 'unknown',
  };
  if (request.options.fps !== 24 && request.options.fps !== 30 && request.options.fps !== 60) {
    throw new TypeError('Distributed chunk execution supports fps 24, 30, or 60');
  }
  const planDir = resolve(
    request.planDir ??
      join(
        dirname(resolve(request.projectDir)),
        `.render-plan-${digest(resolve(request.projectDir)).slice(0, 12)}`,
      ),
  );
  assertPlanDirectory(planDir, request.projectDir);
  const projectDir = resolve(request.projectDir);
  const projectHash = hashProjectDir(projectDir);
  const localPath = localPlanPath(planDir);
  if (await exists(localPath)) {
    try {
      const existing = await readImmutableRenderPlan(planDir);
      if (
        existing.projectHash === projectHash &&
        existing.options.fps === request.options.fps &&
        existing.options.quality === request.options.quality &&
        existing.options.format === request.options.format &&
        (existing.requestedChunkCount ?? existing.chunkCount) === chunkCount &&
        existing.chunkWorkers === chunkWorkers &&
        existing.maxParallelChunks === maxParallelChunks &&
        existing.chunkSizeFrames === request.chunkSizeFrames &&
        existing.targetChunkFrames === request.targetChunkFrames &&
        existing.outputPath === resolve(request.outputPath) &&
        existing.nodeVersion === runtimeVersions.node &&
        existing.chromiumVersion === runtimeVersions.chromium
      ) {
        return existing;
      }
    } catch {
      // A stale or partial plan is replaced below.
    }
    await rm(planDir, { recursive: true, force: true });
    await rm(localPath, { force: true });
  }
  await mkdir(planDir, { recursive: true });
  const dimensions = await readCompositionDimensions(projectDir);
  const previousWorkers = process.env.PRODUCER_MAX_WORKERS;
  process.env.PRODUCER_MAX_WORKERS = String(chunkWorkers);
  let result: PlanResult;
  try {
    result = await (dependencies.plan ?? defaultDeps.plan)(
      projectDir,
      {
        ...toDistributedConfig(request.options, dimensions, {
          chunkSizeFrames: request.chunkSizeFrames,
          maxParallelChunks: chunkCount,
          targetChunkFrames: request.targetChunkFrames,
        }),
        maxParallelChunks: chunkCount,
        abortSignal: request.signal,
      },
      planDir,
    );
  } finally {
    if (previousWorkers === undefined) delete process.env.PRODUCER_MAX_WORKERS;
    else process.env.PRODUCER_MAX_WORKERS = previousWorkers;
  }
  const resolvedChunkCount = result.chunkCount;
  const chunksJson = JSON.parse(
    await readFile(join(planDir, 'meta', 'chunks.json'), 'utf8'),
  ) as Array<{
    index: number;
    startFrame: number;
    endFrame: number;
  }>;
  if (
    chunksJson.length !== resolvedChunkCount ||
    chunksJson.some((chunk, index) => chunk.index !== index || chunk.endFrame <= chunk.startFrame)
  ) {
    throw new ChunkExecutorError('mismatched_chunk', 'Producer returned invalid chunk boundaries');
  }
  const chunks = chunksJson.map((slice) => ({
    ...slice,
    outputPath: chunkPath(planDir, slice.index, result.format),
    status: 'pending' as const,
  }));
  const assets = await collectPlanAssets(planDir);
  const fonts = assets.filter((asset) =>
    /(?:fonts?|\.woff2?|\.ttf|\.otf)(?:\/|$)/i.test(asset.path),
  );
  const runtime = Object.freeze({
    ...(await readPlanRuntime(planDir)),
    captureMode: await readPlanCaptureMode(planDir),
  });
  const plan = freezeRenderPlan({
    schemaVersion: CHUNK_PLAN_SCHEMA_VERSION,
    input: {
      projectDir,
      projectHash,
      outputPath: resolve(request.outputPath),
      options: { ...request.options },
      chunkWorkers,
      maxParallelChunks,
      requestedChunkCount: chunkCount,
      ...(request.chunkSizeFrames ? { chunkSizeFrames: request.chunkSizeFrames } : {}),
      ...(request.targetChunkFrames ? { targetChunkFrames: request.targetChunkFrames } : {}),
      runtimeVersions,
    },
    producer: { ...result, chunkCount: resolvedChunkCount },
    assets,
    fonts,
    runtime,
    chunks,
  });
  const envelope: PlanEnvelope = {
    schemaVersion: CHUNK_PLAN_SCHEMA_VERSION,
    input: {
      projectDir: plan.projectDir,
      projectHash: plan.projectHash,
      outputPath: plan.outputPath,
      options: { ...request.options },
      chunkWorkers,
      maxParallelChunks,
      requestedChunkCount: chunkCount,
      ...(request.chunkSizeFrames ? { chunkSizeFrames: request.chunkSizeFrames } : {}),
      ...(request.targetChunkFrames ? { targetChunkFrames: request.targetChunkFrames } : {}),
      runtimeVersions,
    },
    producer: { ...result, chunkCount: resolvedChunkCount },
    chunks: plan.chunks,
    assets: plan.assets,
    fonts: plan.fonts,
    runtime: plan.runtime,
    planHash: plan.planHash,
    localFingerprint: digest({
      schemaVersion: CHUNK_PLAN_SCHEMA_VERSION,
      input: {
        projectDir: plan.projectDir,
        projectHash: plan.projectHash,
        outputPath: plan.outputPath,
        options: { ...request.options },
        chunkWorkers,
        maxParallelChunks,
        requestedChunkCount: chunkCount,
        ...(request.chunkSizeFrames ? { chunkSizeFrames: request.chunkSizeFrames } : {}),
        ...(request.targetChunkFrames ? { targetChunkFrames: request.targetChunkFrames } : {}),
        runtimeVersions,
      },
      producer: { ...result, chunkCount: resolvedChunkCount },
      assets: plan.assets,
      fonts: plan.fonts,
      runtime: plan.runtime,
      chunks: plan.chunks,
    }),
  };
  await writeFile(localPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return plan;
}

async function renderOne(
  plan: ImmutableRenderPlan,
  chunk: ImmutableChunk,
  dependencies: ChunkExecutorDependencies,
  signal?: AbortSignal,
): Promise<ChunkResult> {
  if (signal?.aborted) throw new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
  await mkdir(dirname(chunk.outputPath), { recursive: true });
  const readResult = dependencies.readChunkResult ?? defaultReadChunkResult;
  const existing = (await exists(chunk.outputPath)) ? await readResult(chunk.outputPath) : null;
  if (existing) {
    try {
      await verifyChunkOutput(chunk, plan.planHash, existing);
      return existing;
    } catch (error) {
      if (error instanceof ChunkExecutorError && error.code === 'mismatched_chunk') throw error;
      await removeOutput(chunk.outputPath);
    }
  }
  await removeOutput(chunk.outputPath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await settleProducer(
        dependencies.renderChunk
          ? dependencies.renderChunk(plan.planDir, chunk.index, chunk.outputPath)
          : renderChunkInTerminatedProcess(plan.planDir, chunk.index, chunk.outputPath, signal),
        signal,
      );
      if (signal?.aborted)
        throw new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
      await verifyChunkOutput(chunk, plan.planHash, result);
      return result;
    } catch (error) {
      if (signal?.aborted) {
        throw new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
      }
      if (error instanceof ChunkExecutorError && error.code !== 'chunk_execution_failed')
        throw error;
      lastError = error;
      await removeOutput(chunk.outputPath);
    }
  }
  throw new ChunkExecutorError(
    'chunk_execution_failed',
    `Chunk ${chunk.index} failed after 2 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function validateChunkResults(
  plan: ImmutableRenderPlan,
  results: readonly (ChunkResult | null | undefined)[],
): asserts results is readonly ChunkResult[] {
  if (
    results.length !== plan.chunkCount ||
    !results.every((result): result is ChunkResult => result !== null && result !== undefined)
  ) {
    throw new ChunkExecutorError('missing_chunk', 'Chunk result set is incomplete');
  }
  const paths = results.map((result) => result.outputPath);
  if (new Set(paths).size !== paths.length) {
    throw new ChunkExecutorError('duplicate_chunk', 'Chunk result set contains duplicate outputs');
  }
  results.forEach((result, index) => {
    const expected = plan.chunks[index];
    if (!expected || result.outputPath !== expected.outputPath) {
      throw new ChunkExecutorError(
        'mismatched_chunk',
        `Chunk result ${index} does not match the immutable plan`,
      );
    }
  });
}

export async function executeRenderChunks(
  request: ChunkExecutionRequest,
  dependencies: ChunkExecutorDependencies = {},
): Promise<ChunkExecutionResult> {
  const startedAt = Date.now();
  const planStartedAt = Date.now();
  const plan = await createRenderPlan(request, dependencies);
  const planMs = Date.now() - planStartedAt;
  const previousWorkers = process.env.PRODUCER_MAX_WORKERS;
  process.env.PRODUCER_MAX_WORKERS = String(plan.chunkWorkers);
  const results = new Array<ChunkResult>(plan.chunks.length);
  try {
    const chunksStartedAt = Date.now();
    await mapBounded(
      plan.chunks,
      plan.maxParallelChunks,
      async (chunk) => {
        await dependencies.onChunkStarted?.(chunk.index);
        const result = await renderOne(plan, chunk, dependencies, request.signal);
        results[chunk.index] = result;
        const complete = results.filter(Boolean).length;
        await request.onProgress?.({
          progress: complete / plan.chunkCount,
          stage: complete === plan.chunkCount ? 'assembling' : 'rendering-chunks',
          framesRendered: results
            .filter(Boolean)
            .reduce((sum, current) => sum + (current?.framesEncoded ?? 0), 0),
          totalFrames: plan.totalFrames,
        });
      },
      request.signal,
    );
    const chunksMs = Date.now() - chunksStartedAt;
    validateChunkResults(plan, results);
    if (request.signal?.aborted)
      throw new ChunkExecutorError('chunk_execution_failed', 'Render cancelled');
    let assembly: AssembleResult;
    const assembleStartedAt = Date.now();
    try {
      const audioPath = join(plan.planDir, 'audio.aac');
      assembly = await (dependencies.assemble ?? defaultDeps.assemble)(
        plan.planDir,
        results.map((result) => result.outputPath),
        (await exists(audioPath)) ? audioPath : null,
        plan.outputPath,
        { abortSignal: request.signal },
      );
    } catch (error) {
      throw new ChunkExecutorError(
        'assembly_failed',
        `Chunk assembly failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const assembleMs = Date.now() - assembleStartedAt;
    return {
      plan,
      assembly,
      chunks: results,
      totalElapsedMs: Date.now() - startedAt,
      stages: { planMs, chunksMs, assembleMs },
    };
  } finally {
    if (previousWorkers === undefined) delete process.env.PRODUCER_MAX_WORKERS;
    else process.env.PRODUCER_MAX_WORKERS = previousWorkers;
  }
}

export async function readImmutableRenderPlan(planDir: string): Promise<ImmutableRenderPlan> {
  const resolvedPlanDir = resolve(planDir);
  const raw = JSON.parse(await readFile(localPlanPath(resolvedPlanDir), 'utf8')) as PlanEnvelope;
  if (raw.schemaVersion !== CHUNK_PLAN_SCHEMA_VERSION) {
    throw new ChunkExecutorError('stale_chunk', 'Unsupported local render plan schema');
  }
  const recomputed = digest({
    schemaVersion: raw.schemaVersion,
    input: raw.input,
    producer: raw.producer,
    assets: raw.assets,
    fonts: raw.fonts,
    runtime: raw.runtime,
    chunks: raw.chunks,
  });
  if (recomputed !== raw.localFingerprint) {
    throw new ChunkExecutorError('stale_chunk', 'Local render plan hash mismatch');
  }
  if (raw.planHash !== raw.producer.planHash) {
    throw new ChunkExecutorError('stale_chunk', 'Producer plan hash mismatch');
  }
  if (resolve(raw.producer.planDir) !== resolvedPlanDir) {
    throw new ChunkExecutorError(
      'stale_chunk',
      'Producer plan directory does not match requested plan',
    );
  }
  if (raw.producer.chunkCount !== raw.chunks.length) {
    throw new ChunkExecutorError(
      'stale_chunk',
      'Plan chunk count does not match producer metadata',
    );
  }
  const chunkRoot = `${resolvedPlanDir}.chunks${sep}`;
  const seen = new Set<number>();
  raw.chunks.forEach((chunk, index) => {
    if (
      chunk.index !== index ||
      seen.has(chunk.index) ||
      chunk.startFrame < 0 ||
      chunk.endFrame <= chunk.startFrame ||
      !resolve(chunk.outputPath).startsWith(chunkRoot)
    ) {
      throw new ChunkExecutorError(
        'stale_chunk',
        'Plan contains invalid chunk boundaries or output paths',
      );
    }
    seen.add(chunk.index);
  });
  return freezeRenderPlan(raw);
}
