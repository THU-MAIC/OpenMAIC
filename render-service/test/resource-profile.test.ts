import { describe, expect, it } from 'vitest';
import { resolveResourceProfile, validateResourceProfileStartup } from '../src/resource-profile.js';

const GIB = 1024 ** 3;

describe('resource profiles', () => {
  it('resolves standard to prefer BeginFrame while allowing compatibility fallback', () => {
    const env: NodeJS.ProcessEnv = {};
    const profile = resolveResourceProfile(env);

    expect(profile).toMatchObject({
      name: 'standard',
      capturePolicy: 'prefer-beginframe',
      requestedCaptureMode: 'beginframe',
      requireBeginFrame: false,
      producerWorkers: 1,
      maxConcurrency: 1,
      maxConcurrentExtractions: 1,
      maxPreviewPixels: 3840 * 2160,
      maxPreviewDeviceScaleFactor: 2,
      minimumMemoryBytes: 8 * GIB,
    });
    expect(env).toMatchObject({
      PRODUCER_MAX_WORKERS: '1',
      PRODUCER_LOW_MEMORY_MODE: 'false',
      PRODUCER_FORCE_SCREENSHOT: 'false',
      PRODUCER_BROWSER_GPU_MODE: 'software',
      PRODUCER_ENABLE_BROWSER_POOL: 'false',
      PRODUCER_EXPECTED_CHROMIUM_MAJOR: '151',
      RENDER_REQUIRE_BEGINFRAME: 'false',
    });
  });

  it('resolves low-memory to an explicit one-worker screenshot profile', () => {
    const env: NodeJS.ProcessEnv = { RENDER_RESOURCE_PROFILE: 'low-memory' };
    const profile = resolveResourceProfile(env);

    expect(profile).toMatchObject({
      name: 'low-memory',
      capturePolicy: 'screenshot-only',
      requestedCaptureMode: 'screenshot',
      requireBeginFrame: false,
      producerWorkers: 1,
      maxPreviewPixels: 1920 * 1080,
      maxPreviewDeviceScaleFactor: 1,
      minimumMemoryBytes: 4 * GIB,
    });
    expect(env).toMatchObject({
      PRODUCER_LOW_MEMORY_MODE: 'true',
      PRODUCER_FORCE_SCREENSHOT: 'true',
      PRODUCER_BROWSER_GPU_MODE: 'software',
      PRODUCER_MAX_WORKERS: '1',
      PRODUCER_ENABLE_BROWSER_POOL: 'false',
      PRODUCER_EXPECTED_CHROMIUM_MAJOR: '151',
      RENDER_REQUIRE_BEGINFRAME: 'false',
    });
  });

  it('rejects unknown profiles and contradictory tuning knobs', () => {
    expect(() => resolveResourceProfile({ RENDER_RESOURCE_PROFILE: 'fast' })).toThrow(
      /expected standard or low-memory/,
    );
    expect(() =>
      resolveResourceProfile({
        RENDER_RESOURCE_PROFILE: 'standard',
        PRODUCER_MAX_WORKERS: '4',
      }),
    ).toThrow(/requires PRODUCER_MAX_WORKERS=1/);
    expect(() =>
      resolveResourceProfile({
        RENDER_RESOURCE_PROFILE: 'low-memory',
        RENDER_MAX_CONCURRENCY: '2',
      }),
    ).toThrow(/requires RENDER_MAX_CONCURRENCY=1/);
    expect(() =>
      resolveResourceProfile({
        RENDER_RESOURCE_PROFILE: 'standard',
        RENDER_REQUIRE_BEGINFRAME: 'true',
      }),
    ).toThrow(/requires RENDER_REQUIRE_BEGINFRAME=false/);
  });

  it('fails before startup when memory is below the selected profile minimum', () => {
    const standard = resolveResourceProfile({ RENDER_RESOURCE_PROFILE: 'standard' });
    expect(() =>
      validateResourceProfileStartup(standard, {
        memoryBytes: 7 * GIB,
        headlessShellPath: '/chromium-headless-shell',
        pathExists: () => true,
      }),
    ).toThrow(/requires at least 8 GiB memory/);

    const lowMemory = resolveResourceProfile({ RENDER_RESOURCE_PROFILE: 'low-memory' });
    expect(() => validateResourceProfileStartup(lowMemory, { memoryBytes: 3 * GIB })).toThrow(
      /requires at least 4 GiB memory/,
    );
  });

  it('fails standard startup when the BeginFrame shell is missing', () => {
    const standard = resolveResourceProfile({ RENDER_RESOURCE_PROFILE: 'standard' });
    expect(() =>
      validateResourceProfileStartup(standard, {
        memoryBytes: 8 * GIB,
        headlessShellPath: '/missing',
        pathExists: () => false,
      }),
    ).toThrow(/requires an existing PRODUCER_HEADLESS_SHELL_PATH/);
  });
});
