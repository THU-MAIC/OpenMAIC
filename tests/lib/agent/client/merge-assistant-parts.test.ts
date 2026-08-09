import { describe, it, expect } from 'vitest';
import { mergeAssistantParts, type PiPart } from '@/lib/agent/client/merge-assistant-parts';

const noTools = new Map<string, { result: unknown; isError: boolean }>();

describe('mergeAssistantParts — reasoning', () => {
  it('flattens a reasoning PiPart into an assistant-ui reasoning part, before the text', () => {
    const turns: PiPart[][] = [
      [
        { type: 'reasoning', text: 'let me think' },
        { type: 'text', text: 'the answer' },
      ],
    ];
    const parts = mergeAssistantParts({ turns, toolResults: noTools, error: '' });
    expect(parts).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'the answer' },
    ]);
  });

  it('drops an empty reasoning part', () => {
    const turns: PiPart[][] = [
      [
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'hi' },
      ],
    ];
    const parts = mergeAssistantParts({ turns, toolResults: noTools, error: '' });
    expect(parts).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('keeps reasoning → toolCall → wrap-up ordering across a turn', () => {
    const turns: PiPart[][] = [
      [
        { type: 'reasoning', text: 'plan' },
        { type: 'toolCall', id: 't1', name: 'edit', arguments: {} },
        { type: 'text', text: 'done' },
      ],
    ];
    const results = new Map([['t1', { result: { ok: true }, isError: false }]]);
    const parts = mergeAssistantParts({ turns, toolResults: results, error: '' });
    expect(parts.map((p) => p.type)).toEqual(['reasoning', 'tool-call', 'text']);
  });
});
