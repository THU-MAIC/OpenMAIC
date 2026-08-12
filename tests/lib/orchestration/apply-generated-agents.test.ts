import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Give this module graph a working window.localStorage BEFORE the registry
// store is imported: the zustand persist middleware resolves its default
// storage from `window.localStorage` at store creation and disables itself
// (including the whole `persist` API) when that throws, which would make the
// persistence-exclusion behavior under test unreachable in the node env.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const localStorageStub: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
  });
});

afterAll(() => {
  // Globals are worker-scoped: undo the stubs so other files keep a clean env.
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

vi.mock('@/lib/audio/agent-voice', () => ({
  warmUpAgentVoices: vi.fn(),
}));

import {
  applyGeneratedAgentsToRegistry,
  useAgentRegistry,
} from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
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
        voiceConfig: { providerId: 'qwen-tts', voiceId: 'voice-1' },
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
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'voice-1' },
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

describe('registry persistence excludes generated agents', () => {
  function makeCustomAgent(id: string): AgentConfig {
    return {
      id,
      name: `Custom ${id}`,
      role: 'student',
      persona: 'Custom persona',
      avatar: 'C',
      color: '#111',
      allowedActions: [],
      priority: 1,
      isDefault: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  it('serializes no generated agents to localStorage (single durable home)', () => {
    useAgentRegistry.getState().addAgent(makeCustomAgent('custom-1'));
    try {
      applyGeneratedAgentsToRegistry('stage-1', [makeConfig('gen-a')]);

      const raw = localStorage.getItem('agent-registry-storage');
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw!) as { state: { agents: Record<string, AgentConfig> } };
      // The roster's only durable home is the stage document.
      expect(persisted.state.agents['gen-a']).toBeUndefined();
      expect(Object.values(persisted.state.agents).some((agent) => agent.isGenerated)).toBe(false);
      // Custom and default agents still persist.
      expect(persisted.state.agents['custom-1']).toBeDefined();
      expect(persisted.state.agents['default-1']).toBeDefined();
    } finally {
      useAgentRegistry.getState().deleteAgent('custom-1');
    }
  });

  it('merge drops persisted generated agents on rehydration (defense in depth)', () => {
    // Pre-partialize snapshots may still carry generated agents; the merge
    // filter is the backstop that keeps them from leaking across sessions.
    const { merge } = useAgentRegistry.persist.getOptions();
    expect(merge).toBeDefined();
    const persisted = {
      agents: {
        'gen-old': { ...makeCustomAgent('gen-old'), isGenerated: true },
        'custom-1': makeCustomAgent('custom-1'),
        'default-1': { ...makeCustomAgent('default-1'), name: 'stale cached teacher' },
      },
    };
    const merged = merge!(persisted, useAgentRegistry.getState()) as {
      agents: Record<string, AgentConfig>;
    };
    expect(merged.agents['gen-old']).toBeUndefined();
    expect(merged.agents['custom-1']).toBeDefined();
    // Default agents always use code-defined values, not the cached copy.
    expect(merged.agents['default-1'].name).toBe('AI teacher');
  });
});
