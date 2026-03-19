import { describe, expect, it, vi } from 'vitest';
import { parseActionsFromStructuredOutput } from '@/lib/generation/action-parser';

vi.mock('nanoid', () => ({
  nanoid: () => 'testid00',
}));

describe('parseActionsFromStructuredOutput', () => {
  describe('basic parsing', () => {
    it('converts text item to speech action', () => {
      const input = '[{"type":"text","content":"hello"}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
      expect((actions[0] as { text: string }).text).toBe('hello');
      expect(actions[0].id).toBe('action_testid00');
    });

    it('converts action item (new format)', () => {
      const input = JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('spotlight');
      expect((actions[0] as { elementId: string }).elementId).toBe('e1');
    });

    it('supports legacy format (tool_name/parameters)', () => {
      const input = JSON.stringify([
        { type: 'action', tool_name: 'spotlight', parameters: { elementId: 'e2' } },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('spotlight');
      expect((actions[0] as { elementId: string }).elementId).toBe('e2');
    });

    it('preserves interleaving order of text and action items', () => {
      const input = JSON.stringify([
        { type: 'text', content: 'first' },
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
        { type: 'text', content: 'second' },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(3);
      expect(actions[0].type).toBe('speech');
      expect(actions[1].type).toBe('spotlight');
      expect(actions[2].type).toBe('speech');
    });

    it('preserves custom action_id', () => {
      const input = JSON.stringify([
        { type: 'action', name: 'spotlight', params: {}, action_id: 'custom_123' },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions[0].id).toBe('custom_123');
    });

    it('preserves custom tool_id (legacy)', () => {
      const input = JSON.stringify([
        { type: 'action', tool_name: 'laser', parameters: {}, tool_id: 'legacy_456' },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions[0].id).toBe('legacy_456');
    });
  });

  describe('fault tolerance', () => {
    it('strips markdown code fences', () => {
      const input = '```json\n[{"type":"text","content":"hi"}]\n```';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('handles trailing text after code fence', () => {
      const input = '```json\n[{"type":"text","content":"hi"}]\n```\nSome notes here';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });

    it('recovers truncated JSON via partial-json', () => {
      const input = '[{"type":"text","content":"hi"';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for non-array JSON', () => {
      const input = '{"type":"text","content":"hi"}';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toEqual([]);
    });

    it('returns empty array for primitive JSON', () => {
      expect(parseActionsFromStructuredOutput('42')).toEqual([]);
      expect(parseActionsFromStructuredOutput('"string"')).toEqual([]);
    });

    it('skips null, empty, and typeless items', () => {
      const input = JSON.stringify([null, {}, { type: 'text', content: 'ok' }]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect((actions[0] as { text: string }).text).toBe('ok');
    });

    it('skips items with unknown type', () => {
      const input = JSON.stringify([
        { type: 'unknown', content: 'x' },
        { type: 'text', content: 'ok' },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });

    it('returns empty array when no JSON array found', () => {
      expect(parseActionsFromStructuredOutput('no json here')).toEqual([]);
    });

    it('skips text items with blank content', () => {
      const input = JSON.stringify([{ type: 'text', content: '   ' }]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toEqual([]);
    });
  });

  describe('post-processing', () => {
    it('truncates actions after discussion (discussion in middle)', () => {
      const input = JSON.stringify([
        { type: 'text', content: 'talk' },
        { type: 'action', name: 'discussion', params: {} },
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('speech');
      expect(actions[1].type).toBe('discussion');
    });

    it('keeps discussion at end unchanged', () => {
      const input = JSON.stringify([
        { type: 'text', content: 'talk' },
        { type: 'action', name: 'discussion', params: {} },
      ]);
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(2);
    });

    it('filters spotlight from non-slide scene', () => {
      const input = JSON.stringify([
        { type: 'text', content: 'hi' },
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
      ]);
      const actions = parseActionsFromStructuredOutput(input, 'quiz');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('filters laser from non-slide scene', () => {
      const input = JSON.stringify([
        { type: 'action', name: 'laser', params: { elementId: 'e1' } },
        { type: 'text', content: 'hi' },
      ]);
      const actions = parseActionsFromStructuredOutput(input, 'quiz');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('sceneType filter takes precedence over allowedActions (early return)', () => {
      const input = JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
        { type: 'text', content: 'hi' },
      ]);
      const actions = parseActionsFromStructuredOutput(input, 'quiz', ['spotlight']);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('filters by allowedActions whitelist when no sceneType', () => {
      const input = JSON.stringify([
        { type: 'text', content: 'hi' },
        { type: 'action', name: 'spotlight', params: { elementId: 'e1' } },
        { type: 'action', name: 'discussion', params: {} },
      ]);
      const actions = parseActionsFromStructuredOutput(input, undefined, ['spotlight']);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('speech');
      expect(actions[1].type).toBe('spotlight');
    });

    it('speech is never filtered by allowedActions', () => {
      const input = JSON.stringify([{ type: 'text', content: 'hi' }]);
      const actions = parseActionsFromStructuredOutput(input, undefined, ['spotlight']);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });
  });
});
