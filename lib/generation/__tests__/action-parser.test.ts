import { describe, it, expect } from 'vitest';
import { parseActionsFromStructuredOutput } from '../action-parser';

describe('parseActionsFromStructuredOutput', () => {
  describe('basic parsing', () => {
    it('parses text items into speech actions', () => {
      const input = '[{"type":"text","content":"Hello students"}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
      expect((actions[0] as { text: string }).text).toBe('Hello students');
    });

    it('parses action items with new format (name/params)', () => {
      const input = '[{"type":"action","name":"spotlight","params":{"elementId":"img_1"}}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('spotlight');
    });

    it('parses legacy format (tool_name/parameters)', () => {
      const input = '[{"type":"action","tool_name":"laser","parameters":{"elementId":"el_2"}}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('laser');
    });

    it('preserves interleaving order of text and actions', () => {
      const input = `[
        {"type":"action","name":"spotlight","params":{"elementId":"x"}},
        {"type":"text","content":"First point"},
        {"type":"action","name":"wb_open","params":{}},
        {"type":"text","content":"Second point"}
      ]`;
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(4);
      expect(actions[0].type).toBe('spotlight');
      expect(actions[1].type).toBe('speech');
      expect(actions[2].type).toBe('wb_open');
      expect(actions[3].type).toBe('speech');
    });

    it('skips empty text content', () => {
      const input = '[{"type":"text","content":""},{"type":"text","content":"  "}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(0);
    });

    it('skips items without type field', () => {
      const input = '[{"content":"no type"},{"type":"text","content":"valid"}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });
  });

  describe('code fence stripping', () => {
    it('strips ```json code fences', () => {
      const input = '```json\n[{"type":"text","content":"hello"}]\n```';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('strips ``` code fences (no language tag)', () => {
      const input = '```\n[{"type":"text","content":"hello"}]\n```';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });
  });

  describe('discussion truncation', () => {
    it('truncates actions after discussion', () => {
      const input = `[
        {"type":"text","content":"Before"},
        {"type":"action","name":"discussion","params":{"topic":"test"}},
        {"type":"text","content":"After discussion - should be removed"}
      ]`;
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('speech');
      expect(actions[1].type).toBe('discussion');
    });

    it('keeps discussion if it is the last action', () => {
      const input = `[
        {"type":"text","content":"Setup"},
        {"type":"action","name":"discussion","params":{"topic":"test"}}
      ]`;
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(2);
    });
  });

  describe('slide-only action filtering', () => {
    it('filters spotlight/laser from non-slide scenes', () => {
      const input = `[
        {"type":"action","name":"spotlight","params":{"elementId":"x"}},
        {"type":"text","content":"Hello"},
        {"type":"action","name":"laser","params":{"elementId":"y"}}
      ]`;
      const actions = parseActionsFromStructuredOutput(input, 'quiz');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('keeps spotlight/laser for slide scenes', () => {
      const input = `[
        {"type":"action","name":"spotlight","params":{"elementId":"x"}},
        {"type":"text","content":"Hello"}
      ]`;
      const actions = parseActionsFromStructuredOutput(input, 'slide');
      expect(actions).toHaveLength(2);
    });

    it('does not filter when sceneType is undefined', () => {
      const input = '[{"type":"action","name":"spotlight","params":{"elementId":"x"}}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });
  });

  describe('allowedActions whitelist', () => {
    it('filters actions not in whitelist', () => {
      const input = `[
        {"type":"action","name":"spotlight","params":{"elementId":"x"}},
        {"type":"text","content":"Hello"},
        {"type":"action","name":"wb_open","params":{}}
      ]`;
      const actions = parseActionsFromStructuredOutput(input, undefined, ['wb_open']);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('speech');
      expect(actions[1].type).toBe('wb_open');
    });

    it('always allows speech actions regardless of whitelist', () => {
      const input = '[{"type":"text","content":"Hello"}]';
      const actions = parseActionsFromStructuredOutput(input, undefined, ['spotlight']);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('speech');
    });

    it('does not filter when allowedActions is empty', () => {
      const input = '[{"type":"action","name":"spotlight","params":{}}]';
      const actions = parseActionsFromStructuredOutput(input, undefined, []);
      expect(actions).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('returns empty array for no JSON array', () => {
      expect(parseActionsFromStructuredOutput('just some text')).toEqual([]);
    });

    it('returns empty array for non-array JSON', () => {
      expect(parseActionsFromStructuredOutput('{"not":"array"}')).toEqual([]);
    });

    it('handles malformed JSON with jsonrepair fallback', () => {
      // Missing quotes on key
      const input = '[{type:"text","content":"hello"}]';
      const actions = parseActionsFromStructuredOutput(input);
      expect(actions).toHaveLength(1);
    });
  });
});
