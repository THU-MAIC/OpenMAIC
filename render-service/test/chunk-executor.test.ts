import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChunkExecutorError,
  createRenderPlan,
  executeRenderChunks,
  freezeRenderPlan,
  renderChunkInTerminatedProcess,
  validateChunkResults,
  type ChunkExecutorDependencies,
} from '../src/chunk-executor.js';
import type { AssembleResult, ChunkResult, PlanResult } from '@hyperframes/producer/distributed';

const scratch: string[] = [];
const options = { fps: 30, quality: 'draft', format: 'mp4' } as const;

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function setup(): { projectDir: string; planDir: string; outputPath: string } {
  const root = join(tmpdir(), `chunk-executor-${randomUUID()}`);
  scratch.push(root);
  return {
    projectDir: join(root, 'project'),
    planDir: join(root, 'plan'),
    outputPath: join(root, 'output.mp4'),
  };
}

async function materializeProject(projectDir: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'index.html'),
    '<div data-composition-id="test" data-width="1920" data-height="1080"></div>',
  );
}

function producerPlan(planDir: string, chunkCount = 3): PlanResult {
  return {
    planDir,
    planHash: 'producer-plan-hash',
    chunkCount,
    totalFrames: 90,
    fps: 30,
    width: 1920,
    height: 1080,
    format: 'mp4',
    ffmpegVersion: 'ffmpeg-test',
    producerVersion: 'producer-test',
  };
}

async function fakePlan(
  _projectDir: string,
  _config: unknown,
  planDir: string,
): Promise<PlanResult> {
  await mkdir(join(planDir, 'meta'), { recursive: true });
  await mkdir(join(planDir, 'compiled', 'assets', 'fonts'), { recursive: true });
  await writeFile(join(planDir, 'compiled', 'index.html'), '<html></html>');
  await writeFile(join(planDir, 'compiled', 'assets', 'fonts', 'test.woff2'), 'font');
  await writeFile(
    join(planDir, 'meta', 'encoder.json'),
    JSON.stringify({ runtimeEnv: { PRODUCER_RUNTIME_TEST: '1' } }),
  );
  await writeFile(
    join(planDir, 'meta', 'chunks.json'),
    JSON.stringify([
      { index: 0, startFrame: 0, endFrame: 30 },
      { index: 1, startFrame: 30, endFrame: 60 },
      { index: 2, startFrame: 60, endFrame: 90 },
    ]),
  );
  return producerPlan(planDir);
}

function fakeChunkResult(
  path: string,
  index: number,
  sha256: string,
  planHash = '',
): ChunkResult & { planHash?: string } {
  return {
    outputPath: path,
    outputKind: 'file',
    framesEncoded: 30,
    sha256,
    durationMs: 1,
    planHashMs: 1,
    sessionBootMs: 0,
    captureStageMs: 1,
    encodeStageMs: 1,
    workers: 1,
    perfPath: `${path}.perf.json`,
    planHash,
  };
}

function deps(overrides: Partial<ChunkExecutorDependencies> = {}): ChunkExecutorDependencies {
  return {
    plan: fakePlan,
    renderChunk: async (_planDir, index, outputPath) => {
      const bytes = Buffer.from(`chunk-${index}`);
      await writeFile(outputPath, bytes);
      const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
      const result = fakeChunkResult(outputPath, index, sha256);
      const { outputPath: _outputPath, perfPath: _perfPath, ...sidecar } = result;
      await writeFile(
        `${outputPath}.perf.json`,
        JSON.stringify({ ...sidecar, planHash: 'producer-plan-hash' }),
      );
      return result;
    },
    assemble: async (_planDir, paths, _audio, outputPath): Promise<AssembleResult> => {
      await writeFile(
        outputPath,
        (await Promise.all(paths.map((path) => readFile(path)))).join(''),
      );
      return { outputPath, durationMs: 1, framesEncoded: 90, fileSize: 1 };
    },
    ...overrides,
  };
}

describe('local bounded chunk executor', () => {
  it('terminates a real child worker on deadline without crashing the parent', async () => {
    const controller = new AbortController();
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'hanging-chunk-worker.mjs',
    );
    const operation = renderChunkInTerminatedProcess(
      '/tmp/plan',
      0,
      '/tmp/chunk.mp4',
      controller.signal,
      fixture,
    );
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toMatchObject<ChunkExecutorError>({
      code: 'chunk_execution_failed',
      message: 'Render cancelled',
    });
    expect(process.connected).not.toBe(false);
  });

  it('freezes immutable plan metadata and preserves producer frame boundaries', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    const plan = await createRenderPlan(
      { ...paths, options, chunkCount: 3, chunkWorkers: 1, maxParallelChunks: 2 },
      deps(),
    );
    expect(plan.chunks.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.chunks)).toBe(true);
    expect(plan.assets.map((asset) => asset.path)).toContain('index.html');
    expect(plan.fonts.map((asset) => asset.path)).toContain('assets/fonts/test.woff2');
    expect(plan.runtime).toEqual({ PRODUCER_RUNTIME_TEST: '1', captureMode: 'unknown' });
  });

  it('limits chunk fan-out and retries an incomplete output idempotently', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const dependencies = deps({
      onChunkStarted: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
      renderChunk: async (_planDir, index, outputPath) => {
        calls += 1;
        const bytes = Buffer.from(`retry-${index}`);
        await writeFile(outputPath, bytes);
        const sha256 = (await import('node:crypto'))
          .createHash('sha256')
          .update(bytes)
          .digest('hex');
        const result = fakeChunkResult(outputPath, index, sha256);
        await writeFile(
          `${outputPath}.perf.json`,
          JSON.stringify({ ...result, planHash: 'producer-plan-hash' }),
        );
        return result;
      },
    });
    const result = await executeRenderChunks(
      { ...paths, options, chunkCount: 3, chunkWorkers: 1, maxParallelChunks: 2 },
      dependencies,
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls).toBe(3);
    expect(result.chunks).toHaveLength(3);

    await executeRenderChunks(
      { ...paths, options, chunkCount: 3, chunkWorkers: 1, maxParallelChunks: 2 },
      dependencies,
    );
    expect(calls).toBe(3);
  });

  it('drains sibling chunks after one worker fails', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    let siblingSettled = false;
    await expect(
      executeRenderChunks(
        { ...paths, options, chunkCount: 3, maxParallelChunks: 2 },
        deps({
          renderChunk: async (_planDir, index, outputPath) => {
            if (index === 0) throw new Error('injected failure');
            await new Promise((resolve) => setTimeout(resolve, 10));
            siblingSettled = true;
            throw new Error('sibling failure');
          },
        }),
      ),
    ).rejects.toThrow('Chunk 0 failed');
    expect(siblingSettled).toBe(true);
  });

  it('does not retry a chunk after cancellation', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    const controller = new AbortController();
    let calls = 0;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execution = executeRenderChunks(
      { ...paths, options, chunkCount: 3, maxParallelChunks: 1, signal: controller.signal },
      deps({
        renderChunk: async () => {
          calls += 1;
          started();
          await settled;
          throw new Error('cancelled render');
        },
      }),
    );
    await startedPromise;
    controller.abort();
    release();
    await expect(execution).rejects.toThrow('Render cancelled');
    expect(calls).toBe(1);
  });

  it('does not reuse a plan created for a different requested fan-out', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    let plans = 0;
    const dependencies = deps({
      plan: async (...args) => {
        plans += 1;
        return deps().plan!(...args);
      },
    });
    await createRenderPlan({ ...paths, options, chunkCount: 2 }, dependencies);
    await createRenderPlan({ ...paths, options, chunkCount: 4 }, dependencies);
    expect(plans).toBe(2);
  });

  it('rejects chunk settings above the selected resource profile limit', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    await expect(createRenderPlan({ ...paths, options, chunkWorkers: 2 }, deps())).rejects.toThrow(
      /chunkWorkers must be <= 1/,
    );
  });

  it('retries only the failed chunk and validates missing, duplicate, and mismatched sets', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    const attempts = new Map<number, number>();
    const result = await executeRenderChunks(
      { ...paths, options, chunkCount: 3, maxParallelChunks: 1 },
      deps({
        renderChunk: async (_planDir, index, outputPath) => {
          attempts.set(index, (attempts.get(index) ?? 0) + 1);
          if (index === 1 && attempts.get(index) === 1) throw new Error('injected chunk failure');
          const bytes = Buffer.from(`chunk-${index}`);
          await writeFile(outputPath, bytes);
          const sha256 = (await import('node:crypto'))
            .createHash('sha256')
            .update(bytes)
            .digest('hex');
          const chunk = fakeChunkResult(outputPath, index, sha256);
          await writeFile(
            `${outputPath}.perf.json`,
            JSON.stringify({ ...chunk, planHash: 'producer-plan-hash' }),
          );
          return chunk;
        },
      }),
    );

    expect(Object.fromEntries(attempts)).toEqual({ 0: 1, 1: 2, 2: 1 });
    expect(() => validateChunkResults(result.plan, result.chunks.slice(0, 2))).toThrowError(
      expect.objectContaining({ code: 'missing_chunk' }),
    );
    expect(() =>
      validateChunkResults(result.plan, [result.chunks[0], result.chunks[0], result.chunks[2]]),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_chunk' }));
    expect(() =>
      validateChunkResults(result.plan, [result.chunks[1], result.chunks[0], result.chunks[2]]),
    ).toThrowError(expect.objectContaining({ code: 'mismatched_chunk' }));
  });

  it('rejects a stale plan and mismatched chunk output', async () => {
    const paths = setup();
    await materializeProject(paths.projectDir);
    const stale = await createRenderPlan({ ...paths, options, chunkCount: 3 }, deps());
    const localPlanPath = `${stale.planDir}.local.json`;
    const localPlan = JSON.parse(await readFile(localPlanPath, 'utf8')) as { planHash: string };
    await writeFile(localPlanPath, JSON.stringify({ ...localPlan, planHash: 'stale' }));
    await expect(
      import('../src/chunk-executor.js').then(({ readImmutableRenderPlan }) =>
        readImmutableRenderPlan(stale.planDir),
      ),
    ).rejects.toMatchObject<ChunkExecutorError>({
      code: 'stale_chunk',
    });
    await expect(
      executeRenderChunks(
        { ...paths, options, chunkCount: 3 },
        deps({
          renderChunk: async (_planDir, index, outputPath) =>
            fakeChunkResult(`${outputPath}-wrong`, index, 'bad'),
        }),
      ),
    ).rejects.toMatchObject<ChunkExecutorError>({ code: 'mismatched_chunk' });
  });

  it('rejects invalid duplicate and missing chunk plans', () => {
    expect(() =>
      freezeRenderPlan({
        schemaVersion: 1,
        input: {
          projectDir: '/p',
          projectHash: 'project-hash',
          outputPath: '/o',
          options,
          chunkWorkers: 1,
          maxParallelChunks: 1,
          runtimeVersions: { node: 'node', chromium: 'chromium' },
        },
        producer: producerPlan('/plan', 1),
        assets: [],
        fonts: [],
        runtime: {},
        chunks: [{ index: 0, startFrame: 0, endFrame: 10, outputPath: '/a', status: 'pending' }],
      }),
    ).not.toThrow();
  });
});
