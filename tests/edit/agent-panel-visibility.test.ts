import { describe, expect, it } from 'vitest';
import { shouldRenderAgentPanel } from '@/components/edit/agent-panel-visibility';

describe('shouldRenderAgentPanel', () => {
  it('renders on scenes that support AI editing', () => {
    expect(
      shouldRenderAgentPanel({ agentEnabled: true, hasMessages: false, isRunning: false }),
    ).toBe(true);
  });

  it('keeps the panel visible on unsupported scenes while a run is active', () => {
    expect(
      shouldRenderAgentPanel({ agentEnabled: false, hasMessages: false, isRunning: true }),
    ).toBe(true);
  });

  it('keeps the panel visible on unsupported scenes when there is conversation history', () => {
    expect(
      shouldRenderAgentPanel({ agentEnabled: false, hasMessages: true, isRunning: false }),
    ).toBe(true);
  });

  it('hides the panel on unsupported scenes with no active or restored thread', () => {
    expect(
      shouldRenderAgentPanel({ agentEnabled: false, hasMessages: false, isRunning: false }),
    ).toBe(false);
  });
});
