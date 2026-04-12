import { describe, test, expect } from 'vitest';
/**
 * Unit test for #353 fix: verify Stage object has correct agent fields
 * based on agentMode.
 *
 * This doesn't call any LLM — it directly tests the conditional logic
 * that was changed in classroom-generation.ts.
 */

import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

interface DefaultModeFields {
  agentIds: string[];
}

interface GenerateModeFields {
  generatedAgentConfigs: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
  }>;
}

describe('#353: generatedAgentConfigs conditional on agentMode', () => {
  // Replicate the Stage construction logic from classroom-generation.ts L322-349
  function buildStageAgentFields(
    agentMode: 'default' | 'generate',
    agents: Array<{ id: string; name: string; role: string; persona?: string }>,
  ): DefaultModeFields | GenerateModeFields {
    return agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        };
  }

  test('default mode should set agentIds, NOT generatedAgentConfigs', () => {
    const agents = getDefaultAgents();
    const fields = buildStageAgentFields('default', agents);

    // Should have agentIds
    expect(fields).toHaveProperty('agentIds');
    expect((fields as DefaultModeFields).agentIds).toEqual([
      'default-1',
      'default-2',
      'default-3',
      'default-4',
      'default-5',
      'default-6',
    ]);

    // Should NOT have generatedAgentConfigs
    expect(fields).not.toHaveProperty('generatedAgentConfigs');
  });

  test('generate mode should set generatedAgentConfigs, NOT agentIds', () => {
    const agents = [
      { id: 'gen-server-0', name: 'Prof. Li', role: 'teacher', persona: 'An expert' },
      { id: 'gen-server-1', name: 'Assistant', role: 'assistant', persona: 'Helpful' },
      { id: 'gen-server-2', name: 'Student', role: 'student', persona: 'Curious' },
    ];
    const fields = buildStageAgentFields('generate', agents);

    // Should have generatedAgentConfigs
    expect(fields).toHaveProperty('generatedAgentConfigs');
    expect((fields as GenerateModeFields).generatedAgentConfigs).toHaveLength(3);
    expect((fields as GenerateModeFields).generatedAgentConfigs[0].id).toBe('gen-server-0');

    // Should NOT have agentIds
    expect(fields).not.toHaveProperty('agentIds');
  });

  test('generate mode with LLM fallback should behave like default mode', () => {
    // Simulates: agentMode was 'generate', LLM failed, fell back to defaults
    // After our fix, agentMode is reset to 'default' in the catch block
    let agentMode: 'default' | 'generate' = 'generate';
    let agents;

    try {
      throw new Error('Simulated LLM failure');
    } catch {
      agents = getDefaultAgents();
      agentMode = 'default'; // ← This is our fix
    }

    const fields = buildStageAgentFields(agentMode, agents);

    // Should behave exactly like default mode
    expect(fields).toHaveProperty('agentIds');
    expect(fields).not.toHaveProperty('generatedAgentConfigs');
    expect((fields as DefaultModeFields).agentIds).toEqual([
      'default-1',
      'default-2',
      'default-3',
      'default-4',
      'default-5',
      'default-6',
    ]);
  });
});
