import { describe, expect, it } from 'vitest';
import { formatChildResult } from '@/lib/chat/pi/tools/child-result';

describe('model-visible child outcomes', () => {
  it('keeps successful speech and distinguishes silence from actions', () => {
    const base = { agentName: 'Teacher', actionCount: 0, status: 'completed' as const };
    expect(formatChildResult({ ...base, text: 'Hello' })).toEqual({
      text: 'Teacher: Hello',
      isError: false,
    });
    expect(formatChildResult({ ...base, text: '' }).text).toContain('stayed silent');
    expect(formatChildResult({ ...base, text: '', actionCount: 2 }).text).toContain(
      'completed 2 classroom action(s)',
    );
  });
  it('does not interpret provider messages as trusted runtime reason codes', () => {
    expect(
      formatChildResult({
        agentName: 'Teacher',
        actionCount: 0,
        text: '',
        status: 'failed',
        stopReason: 'native_timeout',
      }).text,
    ).toContain('execution error');
  });
});
