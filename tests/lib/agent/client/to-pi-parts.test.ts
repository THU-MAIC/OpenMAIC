import { describe, it, expect } from 'vitest';
import { toPiParts, stripThinkBlocks } from '@/lib/agent/client/to-pi-parts';

describe('toPiParts', () => {
  it('maps a thinking content block to a reasoning PiPart', () => {
    const parts = toPiParts([{ type: 'thinking', thinking: 'let me reason' }]);
    expect(parts).toEqual([{ type: 'reasoning', text: 'let me reason' }]);
  });

  it('maps text content to a text part (with <think> blocks stripped)', () => {
    const parts = toPiParts([{ type: 'text', text: '<think>hidden</think>visible' }]);
    expect(parts).toEqual([{ type: 'text', text: 'visible' }]);
  });

  it('maps toolCall content to a toolCall part', () => {
    const parts = toPiParts([{ type: 'toolCall', id: 't1', name: 'edit', arguments: { a: 1 } }]);
    expect(parts).toEqual([{ type: 'toolCall', id: 't1', name: 'edit', arguments: { a: 1 } }]);
  });

  it('preserves chronological order: thinking → toolCall → text', () => {
    const parts = toPiParts([
      { type: 'thinking', thinking: 'plan' },
      { type: 'toolCall', id: 't1', name: 'edit', arguments: {} },
      { type: 'text', text: 'done' },
    ]);
    expect(parts.map((p) => p.type)).toEqual(['reasoning', 'toolCall', 'text']);
  });
});

describe('stripThinkBlocks', () => {
  it('removes closed <think> blocks', () => {
    expect(stripThinkBlocks('<think>x</think>hello')).toBe('hello');
  });
  it('drops an unclosed trailing <think> block', () => {
    expect(stripThinkBlocks('answer<think>still going')).toBe('answer');
  });
});
