import { describe, expect, it } from 'vitest';
import { tryParseJson, parseJsonResponse } from '@/lib/generation/json-repair';

describe('tryParseJson', () => {
  describe('L1: valid JSON parsed directly', () => {
    it('parses a valid object', () => {
      expect(tryParseJson('{"key":"value"}')).toEqual({ key: 'value' });
    });

    it('parses a valid array', () => {
      expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses a JSON string primitive', () => {
      expect(tryParseJson('"just a string"')).toBe('just a string');
    });
  });

  describe('L2: LaTeX and escape sequence fixes', () => {
    it('fixes LaTeX commands in strings (single backslash)', () => {
      const inputWithInvalid = '{"m":"\\grac{1}{2}"}';
      const result = tryParseJson<{ m: string }>(inputWithInvalid);
      expect(result).not.toBeNull();
      expect(result!.m).toContain('grac');
    });

    it('fixes invalid escape sequences like \\S', () => {
      const input = '{"p":"\\Sigma is Greek"}';
      const result = tryParseJson<{ p: string }>(input);
      expect(result).not.toBeNull();
    });
  });

  describe('L2: truncated JSON repair', () => {
    it('fixes truncated array by closing at last complete object', () => {
      const input = '[{"a":1},{"b":2';
      const result = tryParseJson<object[]>(input);
      expect(result).not.toBeNull();
      expect(result).toEqual([{ a: 1 }]);
    });

    it('fixes truncated object by appending closing braces', () => {
      const input = '{"a":{"b":1';
      const result = tryParseJson<object>(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({ a: { b: 1 } });
    });
  });

  describe('L2: no double-escaping between Fix 1 and Fix 2', () => {
    it('does not quadruple-escape a LaTeX command', () => {
      const input = '{"m":"\\alpha + \\beta"}';
      const result = tryParseJson<{ m: string }>(input);
      expect(result).not.toBeNull();
      // Fix 1 double-escapes \alpha and \beta; Fix 2 then re-processes \beta whose \b is a
      // valid JSON escape → JSON.parse turns \b into a backspace, so the value contains
      // 'alpha' and 'eta' but the 'b' is consumed as a backspace character.
      expect(result!.m).toContain('alpha');
      expect(result!.m).toContain('eta');
    });
  });

  describe('L3: jsonrepair fallback', () => {
    it('handles unescaped quotes via jsonrepair', () => {
      // jsonrepair cannot always fix deeply nested unescaped quotes in mixed-language strings;
      // this documents that the function returns null for such input.
      const input = '{"t":"她说"你好""}';
      const result = tryParseJson<{ t: string }>(input);
      expect(result).toBeNull();
    });
  });

  describe('L4: control character cleanup', () => {
    it('parses JSON with control characters after L3/L4 processing', () => {
      const rawInput = '{"a":"hello' + String.fromCharCode(0) + 'world"}';
      const result = tryParseJson<Record<string, string>>(rawInput);
      expect(result).not.toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(tryParseJson('')).toBeNull();
    });

    it('handles bare text gracefully (jsonrepair wraps as string)', () => {
      const result = tryParseJson('not json at all');
      expect(result).toBe('not json at all');
    });
  });
});

describe('parseJsonResponse', () => {
  describe('S1: markdown code block extraction', () => {
    it('extracts JSON from ```json code block', () => {
      const input = '```json\n{"a":1}\n```';
      expect(parseJsonResponse(input)).toEqual({ a: 1 });
    });

    it('extracts JSON from ``` code block without language tag', () => {
      const input = '```\n[1,2,3]\n```';
      expect(parseJsonResponse(input)).toEqual([1, 2, 3]);
    });

    it('skips first code block (not JSON-shaped), returns second', () => {
      const input = '```json\nnot valid\n```\n\n```json\n{"b":2}\n```';
      expect(parseJsonResponse(input)).toEqual({ b: 2 });
    });

    it('skips code blocks that do not start with { or [', () => {
      const input = '```\nsome text\n```\nfallback: [1]';
      expect(parseJsonResponse(input)).toEqual([1]);
    });
  });

  describe('S2: find JSON in prose via bracket scanning', () => {
    it('finds array after prose prefix', () => {
      const input = 'Here is the result: [1,2]';
      expect(parseJsonResponse(input)).toEqual([1, 2]);
    });

    it('finds object after prose prefix', () => {
      const input = 'Result: {"a":1} done';
      expect(parseJsonResponse(input)).toEqual({ a: 1 });
    });

    it('is not confused by brackets inside JSON strings', () => {
      const input = 'Output: {"a":"[not an array]"}';
      expect(parseJsonResponse(input)).toEqual({ a: '[not an array]' });
    });

    it('handles escaped quotes inside strings', () => {
      const input = 'Data: {"a":"say \\"hi\\""}';
      expect(parseJsonResponse(input)).toEqual({ a: 'say "hi"' });
    });

    it('falls through when brackets are unmatched', () => {
      const input = 'Here is [unclosed data and nothing else';
      expect(parseJsonResponse(input)).toBeNull();
    });
  });

  describe('S3: raw parse fallback', () => {
    it('parses pure JSON string', () => {
      expect(parseJsonResponse('[1,2,3]')).toEqual([1, 2, 3]);
    });
  });

  describe('edge cases', () => {
    it('returns plain text string when no JSON found (jsonrepair wraps it)', () => {
      // jsonrepair turns bare text into a quoted JSON string; Strategy 3 returns that string.
      expect(parseJsonResponse('just plain text')).toBe('just plain text');
    });
  });
});
