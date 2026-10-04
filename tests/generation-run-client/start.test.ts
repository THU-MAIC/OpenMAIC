/**
 * A classic run is started with the outline review the learner chose: a
 * learner who asked to always review outlines confirms each one (`wait`);
 * any other run confirms its own outline on the server (`auto`) and goes on
 * whether or not a page is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const started = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/generation-run-client/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation-run-client/api')>()),
  startGenerationRun: async (input: Record<string, unknown>) => {
    started.inputs.push(input);
    return { id: 'run-AAAAAAAAAAAAAAAA' };
  },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  whenAgentRegistryLoaded: async () => true,
  useAgentRegistry: { getState: () => ({ getAgent: () => undefined }) },
}));
vi.mock('@/lib/audio/tts-selection', () => ({ ttsSelection: () => null }));

import { startClassicRun } from '@/lib/generation-run-client/start';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';
import { useSettingsStore } from '@/lib/store/settings';

const start = () =>
  startClassicRun({
    requirement: 'Photosynthesis',
    materialIds: [],
    interactive: false,
    taskEngine: false,
    capabilities: {} as ModelCapabilities,
  });

beforeEach(() => {
  started.inputs = [];
});
afterEach(() => {
  useSettingsStore.setState({ reviewOutlineEnabled: false });
});

describe('the outline review a classic run is started with', () => {
  it('lets the run confirm its own outline when the learner does not review outlines', async () => {
    useSettingsStore.setState({ reviewOutlineEnabled: false });
    await start();
    expect(started.inputs).toHaveLength(1);
    expect(started.inputs[0]).toMatchObject({ outlineReview: 'auto' });
  });

  it('waits for the learner when they asked to always review outlines', async () => {
    useSettingsStore.setState({ reviewOutlineEnabled: true });
    await start();
    expect(started.inputs[0]).toMatchObject({ outlineReview: 'wait' });
  });

  it('reads the setting when the run starts', async () => {
    useSettingsStore.setState({ reviewOutlineEnabled: true });
    await start();
    useSettingsStore.setState({ reviewOutlineEnabled: false });
    await start();
    expect(started.inputs.map((input) => input.outlineReview)).toEqual(['wait', 'auto']);
  });
});
