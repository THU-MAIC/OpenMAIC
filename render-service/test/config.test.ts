/**
 * Config env parsing — specifically the knobs whose zero value is meaningful.
 * `RENDER_MAX_JOBS_PER_USER=0` must *disable* the per-identity guard (documented
 * behavior); the earlier `intEnv` rejected 0 and silently fell back to 1, so the
 * guard couldn't be turned off. Config resolves env once at import, so each case
 * resets the module registry and re-imports under a fresh environment.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const KEY = 'RENDER_MAX_JOBS_PER_USER';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.config;
}

describe('config maxJobsPerUser', () => {
  it('accepts 0 to disable the per-identity guard', async () => {
    process.env[KEY] = '0';
    expect((await loadConfig()).maxJobsPerUser).toBe(0);
  });

  it('accepts a positive override', async () => {
    process.env[KEY] = '5';
    expect((await loadConfig()).maxJobsPerUser).toBe(5);
  });

  it('falls back to the default (1) for negative or non-numeric values', async () => {
    process.env[KEY] = '-3';
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
    process.env[KEY] = 'nonsense';
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
  });

  it('falls back to the default when unset', async () => {
    delete process.env[KEY];
    expect((await loadConfig()).maxJobsPerUser).toBe(1);
  });
});
