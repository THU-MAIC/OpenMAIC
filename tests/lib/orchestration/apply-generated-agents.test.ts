import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/audio/agent-voice', () => ({
  warmUpAgentVoices: vi.fn(),
}));

import {
  applyGeneratedAgentsToRegistry,
  useAgentRegistry,
} from '@/lib/orchestration/registry/store';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

function makeConfig(id: string, extra: Partial<GeneratedAgentConfig> = {}): GeneratedAgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'teacher',
    persona: 'Teach',
    avatar: 'A',
    color: '#000',
    priority: 1,
    ...extra,
  };
}

function generatedAgents() {
  return useAgentRegistry
    .getState()
    .listAgents()
    .filter((agent) => agent.isGenerated);
}

beforeEach(() => {
  // Reset: drop any generated agents left over from a previous test.
  applyGeneratedAgentsToRegistry('reset', []);
});

describe('applyGeneratedAgentsToRegistry', () => {
  it('adds the roster as stage-bound generated agents and returns the ids', () => {
    const voiceDesign = { identity: 'warm', texture: 'low', delivery: 'calm' };
    const ids = applyGeneratedAgentsToRegistry('stage-1', [
      makeConfig('gen-a', {
        voiceDesign,
        voiceConfig: { providerId: 'qwen-tts', modelId: 'qwen3-tts-vc-test', voiceId: 'voice-1' },
      }),
      makeConfig('gen-b', { role: 'student' }),
    ]);

    expect(ids).toEqual(['gen-a', 'gen-b']);
    const agentA = useAgentRegistry.getState().getAgent('gen-a');
    expect(agentA).toMatchObject({
      isGenerated: true,
      isDefault: false,
      boundStageId: 'stage-1',
      voiceDesign,
      voiceConfig: {
        providerId: 'qwen-tts',
        modelId: 'qwen3-tts-vc-test',
        voiceId: 'voice-1',
      },
    });
    const agentB = useAgentRegistry.getState().getAgent('gen-b');
    expect(agentB?.voiceConfig).toBeUndefined();
    // Role-based action grants: students get whiteboard-only actions.
    expect(agentA?.allowedActions).toContain('spotlight');
    expect(agentB?.allowedActions).not.toContain('spotlight');
  });

  it('accepts a custom-provider voice binding (open namespace)', () => {
    applyGeneratedAgentsToRegistry('stage-1', [
      makeConfig('gen-a', { voiceConfig: { providerId: 'custom-tts-mine', voiceId: 'v1' } }),
    ]);
    expect(useAgentRegistry.getState().getAgent('gen-a')?.voiceConfig).toEqual({
      providerId: 'custom-tts-mine',
      voiceId: 'v1',
    });
  });

  it('drops a voice binding whose provider is unknown, keeping the agent and its voiceDesign', () => {
    // The contract keeps providerId an open string; a document (e.g. from an
    // imported ZIP) can carry junk. It must not reach the TTS path via a cast.
    const voiceDesign = { identity: 'warm', texture: 'low', delivery: 'calm' };
    const ids = applyGeneratedAgentsToRegistry('stage-1', [
      makeConfig('gen-a', {
        voiceDesign,
        voiceConfig: { providerId: 'definitely-not-a-tts-provider', voiceId: 'v1' },
      }),
    ]);
    expect(ids).toEqual(['gen-a']);
    const agent = useAgentRegistry.getState().getAgent('gen-a');
    expect(agent?.voiceConfig).toBeUndefined();
    expect(agent?.voiceDesign).toEqual(voiceDesign);
  });

  it('drops a voice binding whose provider id is a prototype-chain key', () => {
    // `'toString' in TTS_PROVIDERS` is true via Object.prototype; the guard
    // must use own-property semantics or crafted zip manifests keep exactly
    // the junk the whitelist was built to stop.
    for (const junk of ['toString', 'constructor']) {
      applyGeneratedAgentsToRegistry('stage-1', [
        makeConfig('gen-a', { voiceConfig: { providerId: junk, voiceId: 'v1' } }),
      ]);
      expect(useAgentRegistry.getState().getAgent('gen-a')?.voiceConfig).toBeUndefined();
    }
  });

  it('replaces previously applied generated agents while keeping defaults', () => {
    applyGeneratedAgentsToRegistry('stage-1', [makeConfig('gen-old')]);
    applyGeneratedAgentsToRegistry('stage-2', [makeConfig('gen-new')]);

    expect(useAgentRegistry.getState().getAgent('gen-old')).toBeUndefined();
    expect(useAgentRegistry.getState().getAgent('gen-new')).toMatchObject({
      boundStageId: 'stage-2',
    });
    expect(useAgentRegistry.getState().getAgent('default-1')?.isDefault).toBe(true);
  });

  it('clears generated agents when applying an empty roster', () => {
    applyGeneratedAgentsToRegistry('stage-1', [makeConfig('gen-a')]);
    const ids = applyGeneratedAgentsToRegistry('stage-2', []);

    expect(ids).toEqual([]);
    expect(generatedAgents()).toEqual([]);
    expect(useAgentRegistry.getState().getAgent('default-1')).toBeDefined();
  });
});
