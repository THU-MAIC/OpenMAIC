import { describe, it, expect, vi, beforeEach } from 'vitest';

// agent-voice pulls browser-only deps transitively (IndexedDB, settings store);
// stub them so we can unit-test the pure narrator-selection logic in node.
vi.mock('@/lib/audio/voxcpm-voices', () => ({ getVoxCPMProviderOptions: vi.fn() }));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({}) } }));

import { pickNarratorAgent, resolveAgentVoiceOptions } from '@/lib/audio/agent-voice';
import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const mockGetOptions = getVoxCPMProviderOptions as unknown as ReturnType<typeof vi.fn>;

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return {
    id: partial.id ?? 'a',
    name: partial.name ?? 'A',
    role: partial.role ?? 'student',
    persona: '',
    avatar: '',
    color: '',
    allowedActions: [],
    priority: 5,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    ...partial,
  };
}

const DESIGN = { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' };

describe('pickNarratorAgent', () => {
  it('prefers the teacher WITH a voiceDesign over a default teacher (the registry-seeding bug)', () => {
    // Registry is always seeded with DEFAULT_AGENTS first, so the default teacher
    // (no voiceDesign) precedes the generated one. Narration must pick the latter.
    const agents = [
      agent({ id: 'default-1', role: 'teacher', isDefault: true }), // no voiceDesign
      agent({ id: 'gen-1', role: 'teacher', voiceDesign: DESIGN, isGenerated: true }),
    ];
    expect(pickNarratorAgent(agents)?.id).toBe('gen-1');
  });

  it('still prefers the voiceDesign teacher regardless of array order', () => {
    const agents = [
      agent({ id: 'gen-1', role: 'teacher', voiceDesign: DESIGN }),
      agent({ id: 'default-1', role: 'teacher', isDefault: true }),
    ];
    expect(pickNarratorAgent(agents)?.id).toBe('gen-1');
  });

  it('falls back to any teacher when none has a voiceDesign', () => {
    const agents = [agent({ id: 'default-1', role: 'teacher', isDefault: true })];
    expect(pickNarratorAgent(agents)?.id).toBe('default-1');
  });

  it('returns undefined when there is no teacher', () => {
    expect(pickNarratorAgent([agent({ role: 'student' })])).toBeUndefined();
    expect(pickNarratorAgent([])).toBeUndefined();
  });
});

describe('resolveAgentVoiceOptions — voice-design source', () => {
  beforeEach(() => {
    mockGetOptions.mockReset();
    mockGetOptions.mockResolvedValue({});
  });
  const opts = { providerId: 'voxcpm-tts', voiceId: 'voxcpm:auto', providerConfig: {} };

  it('uses the real voiceDesign when the agent has one (generated agents)', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', voiceDesign: DESIGN }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toEqual(DESIGN);
  });

  it('falls back to the persona as the descriptor when there is no voiceDesign (preset agents)', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', persona: 'patient mentor' }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toEqual({
      identity: 'patient mentor',
      texture: '',
      delivery: '',
    });
  });

  it('has no descriptor when the agent has neither voiceDesign nor persona', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', persona: '' }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toBeUndefined();
  });
});
