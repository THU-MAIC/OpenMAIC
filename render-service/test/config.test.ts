/**
 * Config env parsing — specifically the knobs whose zero value is meaningful.
 * `RENDER_MAX_JOBS_PER_USER=0` must *disable* the per-identity guard (documented
 * behavior); the earlier `intEnv` rejected 0 and silently fell back to 1, so the
 * guard couldn't be turned off. Config resolves env once at import, so each case
 * resets the module registry and re-imports under a fresh environment.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const KEYS = [
  'RENDER_MAX_JOBS_PER_USER',
  'RENDER_MAX_CONCURRENCY',
  'RENDER_MAX_CONCURRENT_EXTRACTIONS',
  'PRODUCER_MAX_WORKERS',
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

describe('config producerWorkers', () => {
  it('defaults to producer auto-sizing when no explicit override is supplied', async () => {
    delete process.env.PRODUCER_MAX_WORKERS;
    expect((await loadConfig()).producerWorkers).toBeUndefined();
  });

  it('accepts an explicit single-worker profile without silently raising it', async () => {
    process.env.PRODUCER_MAX_WORKERS = '1';
    expect((await loadConfig()).producerWorkers).toBe(1);
  });

  it('ignores zero, negative, or non-numeric values', async () => {
    process.env.PRODUCER_MAX_WORKERS = '0';
    expect((await loadConfig()).producerWorkers).toBeUndefined();
    process.env.PRODUCER_MAX_WORKERS = '-2';
    expect((await loadConfig()).producerWorkers).toBeUndefined();
    process.env.PRODUCER_MAX_WORKERS = 'many';
    expect((await loadConfig()).producerWorkers).toBeUndefined();
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

  it('allows an operator to opt into a higher-throughput profile', async () => {
    process.env.RENDER_MAX_CONCURRENCY = '2';
    process.env.RENDER_MAX_CONCURRENT_EXTRACTIONS = '2';
    const config = await loadConfig();
    expect(config.maxConcurrency).toBe(2);
    expect(config.maxConcurrentExtractions).toBe(2);
  });
});
