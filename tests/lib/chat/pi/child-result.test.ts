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

  it.each(['completed', 'failed', 'exhausted'] as const)(
    'preserves the %s outcome while reporting rejected drawing actions',
    (status) => {
      for (const text of ['', 'The diagram is updated.']) {
        const opts = { agentName: 'Teacher', actionCount: 1, status, text };
        const original = formatChildResult(opts);
        expect(formatChildResult({ ...opts, rejectedDrawingActions: [] })).toEqual(original);
        expect(
          formatChildResult({
            ...opts,
            rejectedDrawingActions: ['wb_draw_line requires params.startY number'],
          }),
        ).toEqual({
          text:
            original.text +
            '\n[Drawing actions rejected, not applied: wb_draw_line requires params.startY number]',
          isError: original.isError,
        });
      }
    },
  );
});
