/**
 * Config env parsing — specifically the knobs whose zero value is meaningful.
 * `RENDER_MAX_JOBS_PER_USER=0` must *disable* the per-identity guard (documented
 * behavior); the earlier `intEnv` rejected 0 and silently fell back to 1, so the
 * guard couldn't be turned off. Config resolves env once at import, so each case
 * resets the module registry and re-imports under a fresh environment.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const KEYS = [
  'RENDER_RESOURCE_PROFILE',
  'RENDER_MAX_JOBS_PER_USER',
  'RENDER_MAX_CONCURRENCY',
  'RENDER_MAX_CONCURRENT_EXTRACTIONS',
  'PRODUCER_MAX_WORKERS',
  'PRODUCER_LOW_MEMORY_MODE',
  'PRODUCER_FORCE_SCREENSHOT',
  'PRODUCER_BROWSER_GPU_MODE',
  'PRODUCER_ENABLE_BROWSER_POOL',
  'RENDER_REQUIRE_BEGINFRAME',
  'RENDER_PREVIEW_TIMEOUT_MS',
  'RENDER_PREVIEW_MAX_IN_FLIGHT',
  'RENDER_PREVIEW_MAX_PER_USER',
] as const;
const originals = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const original = originals[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.config;
}

describe('config maxJobsPerUser', () => {
  it('accepts 0 to disable the per-identity guard', async () => {
    process.env.RENDER_MAX_JOBS_PER_USER = '0';
    expect((await loadConfig()).maxJobsPerUser).toBe(0);
  });

  it('accepts a positive override', async () => {
    process.env.RENDER_MAX_JOBS_PER_USER = '5';
    expect((await loadConfig()).maxJobsPerUser).toBe(5);
  });

  it('falls back to the default (1) for negative or non-numeric values', async () => {
    process.env.RENDER_MAX_JOBS_PER_USER = '-3';
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
    process.env.RENDER_MAX_JOBS_PER_USER = 'nonsense';
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
  });

  it('falls back to the default when unset', async () => {
    delete process.env.RENDER_MAX_JOBS_PER_USER;
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
  });
});

describe('config preview admission', () => {
  it('provides bounded defaults', async () => {
    const config = await loadConfig();
    expect(config.previewDeadlineMs).toBe(20_000);
    expect(config.previewMaxInFlight).toBe(8);
    expect(config.previewMaxPerUser).toBe(2);
  });

  it('accepts explicit overrides and zero to disable the per-user cap', async () => {
    process.env.RENDER_PREVIEW_TIMEOUT_MS = '15000';
    process.env.RENDER_PREVIEW_MAX_IN_FLIGHT = '4';
    process.env.RENDER_PREVIEW_MAX_PER_USER = '0';
    const config = await loadConfig();
    expect(config.previewDeadlineMs).toBe(15_000);
    expect(config.previewMaxInFlight).toBe(4);
    expect(config.previewMaxPerUser).toBe(0);
  });
});

describe('config producerWorkers', () => {
  it('defaults to one explicit worker in the standard profile', async () => {
    delete process.env.PRODUCER_MAX_WORKERS;
    const config = await loadConfig();
    expect(config.producerWorkers).toBe(1);
    expect(config.resourceProfile.capturePolicy).toBe('prefer-beginframe');
    expect(config.requireBeginFrame).toBe(false);
  });

  it('accepts an explicit single-worker profile without silently raising it', async () => {
    process.env.PRODUCER_MAX_WORKERS = '1';
    expect((await loadConfig()).producerWorkers).toBe(1);
  });

  it('rejects worker overrides that contradict the profile', async () => {
    process.env.PRODUCER_MAX_WORKERS = '0';
    await expect(loadConfig()).rejects.toThrow(/requires PRODUCER_MAX_WORKERS=1/);
  });
});

describe('config latency-profile concurrency', () => {
  it('defaults to one render and one extraction at a time', async () => {
    delete process.env.RENDER_MAX_CONCURRENCY;
    delete process.env.RENDER_MAX_CONCURRENT_EXTRACTIONS;
    const config = await loadConfig();
    expect(config.maxConcurrency).toBe(1);
    expect(config.maxConcurrentExtractions).toBe(1);
  });

  it('rejects service concurrency that exceeds the selected profile', async () => {
    process.env.RENDER_MAX_CONCURRENCY = '2';
    process.env.RENDER_MAX_CONCURRENT_EXTRACTIONS = '2';
    await expect(loadConfig()).rejects.toThrow(/requires RENDER_MAX_CONCURRENCY=1/);
  });

  it('selects the explicit low-memory profile', async () => {
    process.env.RENDER_RESOURCE_PROFILE = 'low-memory';
    const config = await loadConfig();
    expect(config.resourceProfile.name).toBe('low-memory');
    expect(config.requireBeginFrame).toBe(false);
    expect(config.producerWorkers).toBe(1);
  });
});
