#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderJob, executeRenderJob } from '@hyperframes/producer';
import {
  collectCaseFiles,
  computeCaseHashes,
  createDeterministicArchive,
  loadCorpusManifest,
  materializeArchive,
  verifyCaseHashes,
} from '../src/benchmark/corpus.js';
import { classifyFailure } from '../src/benchmark/failure.js';
import {
  compareRepresentativeFrames,
  probeVideo,
  runCommand,
  validateProbeMetrics,
  validateRepresentativeFrameVariation,
} from '../src/benchmark/media-checks.js';
import { ResourceSampler } from '../src/benchmark/resources.js';
import { summarizeRuns } from '../src/benchmark/stats.js';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkReport,
  type BenchmarkRun,
  type CorpusCase,
} from '../src/benchmark/types.js';

interface Options {
  cases: string[];
  runs: number;
  fps: number;
  quality: 'draft' | 'standard' | 'high';
  workers: number | undefined;
  timeoutMs: number;
  outputDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  chromiumPath: string | undefined;
  verifyOnly: boolean;
  printHashes: boolean;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const renderServiceRoot = resolve(scriptDir, '..');
const repositoryRoot = resolve(renderServiceRoot, '..');
const corpusRoot = join(renderServiceRoot, 'benchmark', 'corpus');
const manifestPath = join(corpusRoot, 'manifest.json');

function valueAfter(args: string[], index: number, name: string): string {
  const inline = args[index].slice(name.length + 1);
  if (inline) return inline;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index + 1, 1);
  return value;
}

function positiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const options: Options = {
    cases: [],
    runs: 3,
    fps: 30,
    quality: 'standard',
    workers: undefined,
    timeoutMs: 90 * 60 * 1000,
    outputDir: join(renderServiceRoot, 'benchmark', 'results', timestamp),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    chromiumPath:
      process.env.PRODUCER_HEADLESS_SHELL_PATH ||
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      undefined,
    verifyOnly: false,
    printHashes: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--print-hashes') options.printHashes = true;
    else if (arg === '--case' || arg.startsWith('--case=')) {
      options.cases.push(...valueAfter(args, index, '--case').split(',').filter(Boolean));
    } else if (arg === '--runs' || arg.startsWith('--runs=')) {
      options.runs = positiveInteger(valueAfter(args, index, '--runs'), '--runs');
    } else if (arg === '--fps' || arg.startsWith('--fps=')) {
      options.fps = positiveInteger(valueAfter(args, index, '--fps'), '--fps');
    } else if (arg === '--quality' || arg.startsWith('--quality=')) {
      const quality = valueAfter(args, index, '--quality');
      if (!['draft', 'standard', 'high'].includes(quality)) {
        throw new Error('--quality must be draft, standard, or high');
      }
      options.quality = quality as Options['quality'];
    } else if (arg === '--workers' || arg.startsWith('--workers=')) {
      const workers = valueAfter(args, index, '--workers');
      options.workers = workers === 'auto' ? undefined : positiveInteger(workers, '--workers');
    } else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = positiveInteger(valueAfter(args, index, '--timeout-ms'), '--timeout-ms');
    } else if (arg === '--output-dir' || arg.startsWith('--output-dir=')) {
      options.outputDir = resolve(valueAfter(args, index, '--output-dir'));
    } else if (arg === '--ffmpeg' || arg.startsWith('--ffmpeg=')) {
      options.ffmpegPath = valueAfter(args, index, '--ffmpeg');
    } else if (arg === '--ffprobe' || arg.startsWith('--ffprobe=')) {
      options.ffprobePath = valueAfter(args, index, '--ffprobe');
    } else if (arg === '--chromium' || arg.startsWith('--chromium=')) {
      options.chromiumPath = valueAfter(args, index, '--chromium');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function commandVersion(command: string, args = ['-version']): Promise<string> {
  return (await runCommand(command, args)).split('\n')[0].trim();
}

async function producerVersion(): Promise<string> {
  const path = join(renderServiceRoot, 'node_modules', '@hyperframes', 'producer', 'package.json');
  return (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version;
}

async function runtimeInfo(options: Options): Promise<BenchmarkReport['runtime']> {
  const [producer, ffmpeg, ffprobe, chromium] = await Promise.all([
    producerVersion(),
    commandVersion(options.ffmpegPath),
    commandVersion(options.ffprobePath),
    options.chromiumPath
      ? commandVersion(options.chromiumPath, ['--version']).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    producer,
    ffmpeg,
    ffmpegPath: options.ffmpegPath,
    ffprobe,
    ffprobePath: options.ffprobePath,
    chromium,
    chromiumPath: options.chromiumPath ?? null,
    containerImage: process.env.BENCHMARK_CONTAINER_IMAGE || null,
  };
}

function selectedCases(all: CorpusCase[], ids: string[]): CorpusCase[] {
  if (ids.length === 0) return all;
  const selected = all.filter((entry) => ids.includes(entry.id));
  const missing = ids.filter((id) => !selected.some((entry) => entry.id === id));
  if (missing.length > 0) throw new Error(`Unknown benchmark case(s): ${missing.join(', ')}`);
  return selected;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  process.env.HYPERFRAMES_FFMPEG_PATH = options.ffmpegPath;
  process.env.HYPERFRAMES_FFPROBE_PATH = options.ffprobePath;
  if (options.chromiumPath) process.env.PRODUCER_HEADLESS_SHELL_PATH = options.chromiumPath;
  const manifest = await loadCorpusManifest(manifestPath);
  const cases = selectedCases(manifest.cases, options.cases);
  const prepared = new Map<
    string,
    { benchmarkCase: CorpusCase; archive: Uint8Array; hashes: ReturnType<typeof computeCaseHashes> }
  >();

  for (const benchmarkCase of cases) {
    const files = await collectCaseFiles({
      benchmarkCase,
      manifest,
      corpusRoot,
      repositoryRoot,
    });
    const hashes = computeCaseHashes(files);
    if (!options.printHashes) verifyCaseHashes(benchmarkCase, hashes);
    prepared.set(benchmarkCase.id, {
      benchmarkCase,
      archive: createDeterministicArchive(files),
      hashes,
    });
  }

  if (options.printHashes) {
    console.log(
      JSON.stringify(
        Object.fromEntries([...prepared].map(([id, entry]) => [id, entry.hashes])),
        null,
        2,
      ),
    );
    return;
  }

  if (options.verifyOnly) {
    console.log(
      JSON.stringify({ ok: true, corpusVersion: manifest.corpusVersion, cases: cases.length }),
    );
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const inputArchiveDir = join(options.outputDir, 'input-archives');
  await mkdir(inputArchiveDir, { recursive: true });
  for (const [caseId, entry] of prepared) {
    await writeFile(join(inputArchiveDir, `${caseId}.zip`), entry.archive);
  }

  const report: BenchmarkReport = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    command: process.argv.map((value) => JSON.stringify(value)).join(' '),
    runtime: await runtimeInfo(options),
    corpus: { version: manifest.corpusVersion, cases },
    runs: [],
    summaries: [],
  };

  for (const benchmarkCase of cases) {
    const entry = prepared.get(benchmarkCase.id)!;
    let baselineEstablished = false;
    for (let iteration = 1; iteration <= options.runs; iteration += 1) {
      const runId = `${benchmarkCase.id}-${iteration}-${randomUUID().slice(0, 8)}`;
      const runDir = join(options.outputDir, 'runs', `${benchmarkCase.id}-${iteration}`);
      const projectDir = join(runDir, 'project');
      const outputPath = join(runDir, 'output.mp4');
      await materializeArchive(entry.archive, projectDir);

      const sampler = new ResourceSampler(runDir);
      await sampler.start();
      const job = createRenderJob({
        fps: options.fps,
        quality: options.quality,
        format: 'mp4',
        ...(options.workers === undefined ? {} : { workers: options.workers }),
      });
      const abort = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, options.timeoutMs);
      const startedAt = new Date();
      const wallStart = performance.now();
      let renderError: unknown = null;
      try {
        await executeRenderJob(job, projectDir, outputPath, undefined, abort.signal);
      } catch (error) {
        renderError = error;
      } finally {
        clearTimeout(timeout);
      }
      const wallTimeMs = performance.now() - wallStart;
      const resources = await sampler.stop();
      if (job.perfSummary?.peakRssMb) {
        resources.peakRssBytes = Math.max(
          resources.peakRssBytes,
          job.perfSummary.peakRssMb * 1024 * 1024,
        );
      }
      if (job.perfSummary?.tmpPeakBytes) {
        resources.temporaryDiskPeakBytes = Math.max(
          resources.temporaryDiskPeakBytes,
          job.perfSummary.tmpPeakBytes,
        );
      }

      let probe = null;
      let representativeFrames: BenchmarkRun['representativeFrames'] = [];
      if (!renderError && job.status === 'complete') {
        try {
          probe = await probeVideo(options.ffprobePath, outputPath, options.fps);
          validateProbeMetrics(
            probe,
            benchmarkCase.durationSeconds,
            options.fps,
            benchmarkCase.expectedAudio,
          );
          representativeFrames = await compareRepresentativeFrames({
            ffmpegPath: options.ffmpegPath,
            videoPath: outputPath,
            caseId: benchmarkCase.id,
            durationSeconds: benchmarkCase.durationSeconds,
            fractions: benchmarkCase.representativeFrameFractions,
            frameDir: join(runDir, 'representative-frames'),
            baselineDir: join(options.outputDir, 'frame-baseline'),
            establishBaseline: !baselineEstablished,
          });
          validateRepresentativeFrameVariation(representativeFrames);
          if (representativeFrames.some((frame) => frame.matchesBaseline === false)) {
            throw new Error('Representative frame comparison failed');
          }
          baselineEstablished = true;
        } catch (error) {
          renderError = error;
        }
      } else if (!renderError) {
        renderError = new Error(job.error || `Producer ended with status ${job.status}`);
      }

      const errorMessage =
        renderError instanceof Error ? renderError.message : String(renderError || '');
      const succeeded = !renderError;
      const run: BenchmarkRun = {
        schemaVersion: BENCHMARK_SCHEMA_VERSION,
        runId,
        caseId: benchmarkCase.id,
        iteration,
        startedAt: startedAt.toISOString(),
        status: succeeded ? 'succeeded' : timedOut ? 'timeout' : 'failed',
        failureClassification: succeeded
          ? null
          : classifyFailure({ timedOut, failedStage: job.failedStage, error: errorMessage }),
        error: succeeded ? null : errorMessage,
        input: { corpusVersion: manifest.corpusVersion, ...entry.hashes },
        render: {
          fps: options.fps,
          quality: options.quality,
          requestedWorkers: options.workers ?? null,
          actualWorkers: job.perfSummary?.workers ?? null,
          actualCaptureMode: job.perfSummary?.drawElement?.mode ?? 'unknown',
          resolution: job.perfSummary?.resolution ?? null,
          frameCount: job.perfSummary?.totalFrames ?? null,
        },
        metrics: {
          wallTimeMs,
          stages: job.perfSummary?.stages ?? job.errorDetails?.perfStages ?? {},
          resources,
          probe,
        },
        representativeFrames,
        producerPerfSummary: job.perfSummary ?? null,
      };
      report.runs.push(run);
      report.summaries = summarizeRuns(report.runs);
      report.generatedAt = new Date().toISOString();
      await writeJson(join(runDir, 'run.json'), run);
      await writeJson(join(options.outputDir, 'report.json'), report);
      console.log(
        `${run.caseId} run ${iteration}/${options.runs}: ${run.status} ` +
          `(${Math.round(run.metrics.wallTimeMs)}ms, capture=${run.render.actualCaptureMode})`,
      );
    }
  }

  if (report.runs.some((run) => run.status !== 'succeeded')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
