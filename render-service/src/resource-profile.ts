import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const GIB = 1024 ** 3;

export type ResourceProfileName = 'standard' | 'low-memory';
export type RequestedCaptureMode = 'beginframe' | 'screenshot';
export type CapturePolicy = 'prefer-beginframe' | 'screenshot-only';

export interface ResourceProfile {
  name: ResourceProfileName;
  capturePolicy: CapturePolicy;
  requestedCaptureMode: RequestedCaptureMode;
  requireBeginFrame: boolean;
  producerWorkers: 1;
  maxConcurrency: 1;
  maxConcurrentExtractions: 1;
  /** Hard local chunk fan-out limits for the selected memory/CPU profile. */
  maxChunkWorkers: number;
  maxParallelChunks: number;
  minimumMemoryBytes: number;
}

const COMMON_LIMITS = {
  producerWorkers: 1,
  maxConcurrency: 1,
  maxConcurrentExtractions: 1,
} as const;

function defineProfile(
  name: ResourceProfileName,
  capturePolicy: CapturePolicy,
  minimumMemoryBytes: number,
  maxParallelChunks: number,
): ResourceProfile {
  const requestedCaptureMode = capturePolicy === 'screenshot-only' ? 'screenshot' : 'beginframe';
  return {
    name,
    capturePolicy,
    requestedCaptureMode,
    // BeginFrame is preferred by the standard profile, but producer may select
    // screenshot for compatibility-sensitive compositions such as iframe GenUI.
    requireBeginFrame: false,
    ...COMMON_LIMITS,
    minimumMemoryBytes,
    maxChunkWorkers: 1,
    maxParallelChunks,
  };
}

const PROFILES: Record<ResourceProfileName, ResourceProfile> = {
  standard: defineProfile('standard', 'prefer-beginframe', 8 * GIB, 4),
  'low-memory': defineProfile('low-memory', 'screenshot-only', 4 * GIB, 1),
};

function requiredProducerEnvironment(profile: ResourceProfile): Record<string, string> {
  const screenshot = profile.requestedCaptureMode === 'screenshot';
  return {
    PRODUCER_MAX_WORKERS: String(profile.producerWorkers),
    PRODUCER_LOW_MEMORY_MODE: String(screenshot),
    PRODUCER_FORCE_SCREENSHOT: String(screenshot),
    // The producer's software selector uses SwiftShader and keeps BeginFrame
    // eligible with no host GPU or device passthrough.
    PRODUCER_BROWSER_GPU_MODE: 'software',
    PRODUCER_ENABLE_BROWSER_POOL: 'false',
    PRODUCER_EXPECTED_CHROMIUM_MAJOR: '151',
    RENDER_REQUIRE_BEGINFRAME: String(profile.requireBeginFrame),
  };
}

function assertCompatibleEnvironment(profile: ResourceProfile, env: NodeJS.ProcessEnv): void {
  const producerEnvironment = requiredProducerEnvironment(profile);
  const constraints = [
    ...Object.entries(producerEnvironment).map(([name, required]) => ({
      name,
      required,
      exportToProducer: true,
    })),
    {
      name: 'RENDER_MAX_CONCURRENCY',
      required: String(profile.maxConcurrency),
      exportToProducer: false,
    },
    {
      name: 'RENDER_MAX_CONCURRENT_EXTRACTIONS',
      required: String(profile.maxConcurrentExtractions),
      exportToProducer: false,
    },
  ];

  for (const { name, required, exportToProducer } of constraints) {
    const configured = env[name];
    if (configured !== undefined && configured !== required) {
      throw new Error(
        `RENDER_RESOURCE_PROFILE=${profile.name} requires ${name}=${required}; ` +
          `received ${configured}. Select a different resource profile instead of overriding it.`,
      );
    }
    if (exportToProducer) env[name] = required;
  }
}

export function resolveResourceProfile(env: NodeJS.ProcessEnv = process.env): ResourceProfile {
  const raw = env.RENDER_RESOURCE_PROFILE?.trim() || 'standard';
  if (raw !== 'standard' && raw !== 'low-memory') {
    throw new Error(`Invalid RENDER_RESOURCE_PROFILE=${raw}; expected standard or low-memory.`);
  }
  const profile = PROFILES[raw];
  assertCompatibleEnvironment(profile, env);
  return profile;
}

function finiteMemoryLimit(path: string): number | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Effective host/cgroup memory available to this process. */
export function availableMemoryBytes(): number {
  const limits = [
    totalmem(),
    finiteMemoryLimit('/sys/fs/cgroup/memory.max'),
    finiteMemoryLimit('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
  ].filter((value): value is number => value !== undefined);
  return Math.min(...limits);
}

export function validateResourceProfileStartup(
  profile: ResourceProfile,
  options: {
    memoryBytes?: number;
    headlessShellPath?: string;
    pathExists?: (path: string) => boolean;
  } = {},
): void {
  const memoryBytes = options.memoryBytes ?? availableMemoryBytes();
  if (memoryBytes < profile.minimumMemoryBytes) {
    const actualGiB = (memoryBytes / GIB).toFixed(1);
    const minimumGiB = profile.minimumMemoryBytes / GIB;
    throw new Error(
      `Render resource profile ${profile.name} requires at least ${minimumGiB} GiB memory; ` +
        `detected ${actualGiB} GiB.`,
    );
  }

  if (profile.requestedCaptureMode === 'beginframe') {
    const headlessShellPath = options.headlessShellPath ?? process.env.PRODUCER_HEADLESS_SHELL_PATH;
    const pathExists = options.pathExists ?? existsSync;
    if (!headlessShellPath || !pathExists(headlessShellPath)) {
      throw new Error(
        `Render resource profile ${profile.name} requires an existing ` +
          'PRODUCER_HEADLESS_SHELL_PATH for BeginFrame capture.',
      );
    }
  }
}

export function publicResourceProfile(profile: ResourceProfile) {
  return {
    name: profile.name,
    capturePolicy: profile.capturePolicy,
    requestedCaptureMode: profile.requestedCaptureMode,
    requireBeginFrame: profile.requireBeginFrame,
    producerWorkers: profile.producerWorkers,
    maxConcurrency: profile.maxConcurrency,
    maxConcurrentExtractions: profile.maxConcurrentExtractions,
    maxChunkWorkers: profile.maxChunkWorkers,
    maxParallelChunks: profile.maxParallelChunks,
    minimumMemoryMiB: profile.minimumMemoryBytes / 1024 ** 2,
  } as const;
}
