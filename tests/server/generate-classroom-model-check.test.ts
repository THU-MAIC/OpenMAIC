/**
 * The headless API's up-front model check against real slot resolution: the
 * configuration layers are set, nothing about resolving or building a model
 * is mocked, and no provider is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

type ModelConfigFile = ModelConfigLayer['config'];

async function check(deployment: ModelConfigFile | null, workspace: ModelConfigFile | null = null) {
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setDeploymentConfigForTests({
    layer: deployment ? { source: 'deployment', config: deployment } : null,
    defaults: null,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async () =>
    workspace ? { source: 'workspace', config: workspace } : null,
  );
  const { requiredModelRefusal } = await import('@/lib/server/generate-classroom-job');
  return requiredModelRefusal('owner-1');
}

const MAIN = { main: { preset: 'openai', apiKey: 'sk-operator' } };

describe('requiredModelRefusal', () => {
  beforeEach(() => {
    vi.resetModules();
    // No database: the owner is its own workspace.
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  });

  afterEach(async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    runtime.setWorkspaceLayerLoaderForTests();
    vi.unstubAllEnvs();
  });

  it('passes when every stage a run needs resolves', async () => {
    expect(await check({ providers: MAIN, slots: { llm: 'main:gpt-4o-mini' } })).toBeNull();
  });

  it('passes without an agents model: a run falls back to the built-in agents', async () => {
    expect(
      await check({
        providers: MAIN,
        slots: { llm: 'main:gpt-4o-mini', 'course.agents': null },
      }),
    ).toBeNull();
  });

  it('refuses when nothing is configured', async () => {
    expect(await check(null)).toEqual({
      code: 'MISSING_MODEL',
      message: expect.stringContaining('No model is configured for course.outline'),
    });
  });

  it.each([
    // A parent turned off turns off every scene type under it; the first is named.
    ['course.outline', 'course.outline'],
    ['course.content', 'course.content.slide'],
    ['course.actions', 'course.actions'],
  ])('refuses %s turned off while llm is assigned', async (slot, named) => {
    expect(
      await check({ providers: MAIN, slots: { llm: 'main:gpt-4o-mini', [slot]: null } }),
    ).toEqual({
      code: 'MISSING_MODEL',
      message: `The ${named} capability is turned off in the model configuration`,
    });
  });

  it('accepts content assigned per scene type only, with the parent and llm unassigned', async () => {
    const model = 'main:gpt-4o-mini';
    expect(
      await check({
        providers: MAIN,
        slots: {
          'course.outline': model,
          'course.actions': model,
          'course.content.slide': model,
          'course.content.quiz': model,
          'course.content.interactive': model,
          'course.content.pbl': model,
        },
      }),
    ).toBeNull();
  });

  it('accepts a valid parent with one broken scene type (that type fails at its scene)', async () => {
    expect(
      await check({
        providers: { ...MAIN, keyless: { preset: 'openai' } },
        slots: { llm: 'main:gpt-4o-mini', 'course.content.quiz': 'keyless:gpt-4o-mini' },
      }),
    ).toBeNull();
  });

  it('refuses when no scene type resolves, with the first type in order', async () => {
    const model = 'main:gpt-4o-mini';
    expect(
      await check({
        providers: MAIN,
        slots: { 'course.outline': model, 'course.actions': model },
      }),
    ).toEqual({
      code: 'MISSING_MODEL',
      message: expect.stringContaining('No model is configured for course.content.slide'),
    });
  });

  it("refuses with a scene type's configuration error when no type resolves", async () => {
    const model = 'main:gpt-4o-mini';
    expect(
      await check({
        providers: { ...MAIN, keyless: { preset: 'openai' } },
        slots: {
          'course.outline': model,
          'course.actions': model,
          'course.content': 'keyless:gpt-4o-mini',
        },
      }),
    ).toEqual({
      code: 'MISSING_API_KEY',
      message: expect.stringContaining('API key required for provider: openai'),
    });
  });

  it('refuses a provider that needs a key and has none, before building a model', async () => {
    expect(
      await check({
        providers: { keyless: { preset: 'openai' } },
        slots: { llm: 'keyless:gpt-4o-mini' },
      }),
    ).toEqual({
      code: 'MISSING_API_KEY',
      message: expect.stringContaining('API key required for provider: openai'),
    });
  });

  it('refuses a workspace endpoint on a private network', async () => {
    expect(
      await check(null, {
        providers: {
          local: {
            preset: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: 'k',
          },
        },
        slots: { llm: 'local:m' },
      }),
    ).toEqual({
      code: 'INVALID_URL',
      message: expect.stringMatching(/Local\/private network URLs are not allowed/),
    });
  });

  it('refuses options only the deployment may set, from a workspace', async () => {
    expect(
      await check(null, {
        providers: { p: { preset: 'openai', apiKey: 'k', proxy: 'http://10.0.0.1:3128' } },
        slots: { llm: 'p:m' },
      }),
    ).toEqual({
      code: 'MODEL_CONFIG_INVALID',
      message: 'A proxy can only be configured by the deployment (openmaic.yml)',
    });
  });
});
