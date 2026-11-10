import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import type { Scene, GeneratedAgentConfig } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), persist: vi.fn() }));
vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: mocks.fetch,
}));
vi.mock('node:dns', async (original) => {
  const actual = await original<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: mocks.lookup } };
});
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

function input(teacher: Partial<GeneratedAgentConfig>) {
  return {
    scene: {
      id: 'scene',
      stageId: 'stage',
      order: 0,
      title: 'Test',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'speech', type: 'speech', text: 'Hello' }],
    } as Scene,
    force: false,
    roster: [{ id: 't', name: 'Ms. Lane', role: 'teacher', ...teacher }] as GeneratedAgentConfig[],
  };
}

describe('agent scene narration with the VoxCPM auto voice', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', '');
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: {
            speech: {
              preset: 'voxcpm-tts',
              apiKey: 'test-key',
              baseUrl: 'https://voxcpm.example.com/v1',
              options: { backend: 'nano-vllm' },
            },
          },
          slots: { tts: 'speech:voxcpm2' },
        },
      },
      legacy: false,
      notices: [],
    });
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.persist.mockReset().mockResolvedValue('media/tts-speech.wav');
    mocks.fetch.mockReset().mockResolvedValue(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { 'content-type': 'audio/wav' },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setDeploymentConfigForTests();
    vi.restoreAllMocks();
  });

  it('designs the voice from the unbound teacher instead of failing every line', async () => {
    const result = await synthesizeSceneNarration(
      input({ persona: 'A warm, patient teacher who speaks slowly.' }),
    );
    expect(result).toMatchObject({ generated: 1, failed: [] });
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body as string);
    expect(JSON.stringify(body)).toContain('A warm, patient teacher who speaks slowly.');
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it('falls back to the teacher role and name when there is no persona', async () => {
    const result = await synthesizeSceneNarration(input({}));
    expect(result).toMatchObject({ generated: 1, failed: [] });
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[0][1].body as string))).toContain(
      'teacher Ms. Lane',
    );
  });
});
