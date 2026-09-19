import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { assembleRunnerTools } from '@/lib/server/agent-runtime/runner-contract';

function tool(name: string): AgentTool {
  return { name, description: `tool-${name}` } as unknown as AgentTool;
}

describe('assembleRunnerTools', () => {
  it('flattens tool groups into a single runner tool list, preserving order', () => {
    const tools = assembleRunnerTools([tool('a'), tool('b')], [], [tool('c')]);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list when no groups are given', () => {
    expect(assembleRunnerTools()).toEqual([]);
  });
});
