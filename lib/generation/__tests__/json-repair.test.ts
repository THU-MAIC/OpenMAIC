import { describe, it, expect } from 'vitest';
import { parseJsonResponse, tryParseJson } from '../json-repair';

describe('tryParseJson', () => {
  it('parses valid JSON object', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses valid JSON array', () => {
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('fixes LaTeX-style escapes in strings', () => {
    // Use String.raw to avoid JS interpreting \f as form feed
    const input = String.raw`{"formula":"\\frac{1}{2}"}`;
    const result = tryParseJson<{ formula: string }>(input);
    expect(result).not.toBeNull();
    expect(result!.formula).toContain('frac');
  });

  it('fixes truncated JSON array by closing at last complete object', () => {
    const input = '[{"a":1},{"b":2},{"c":3';
    const result = tryParseJson<Array<Record<string, number>>>(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThanOrEqual(2);
  });

  it('fixes truncated JSON object by adding missing braces', () => {
    const input = '{"a":{"b":1}';
    const result = tryParseJson<Record<string, unknown>>(input);
    expect(result).not.toBeNull();
  });

  it('handles control characters by replacing them', () => {
    const input = '{"text":"hello\x01world"}';
    const result = tryParseJson<{ text: string }>(input);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('hello');
  });

  it('jsonrepair recovers plain text as a JSON string', () => {
    // jsonrepair treats unquoted text as a string, so tryParseJson succeeds
    const result = tryParseJson('not json at all');
    expect(result).toBe('not json at all');
  });

  it('handles Chinese text in JSON', () => {
    const input = '{"title":"这是中文标题","content":"你好世界"}';
    const result = tryParseJson<{ title: string; content: string }>(input);
    expect(result).toEqual({ title: '这是中文标题', content: '你好世界' });
  });
});

describe('parseJsonResponse', () => {
  it('extracts JSON from markdown code block', () => {
    const input = 'Here is the result:\n```json\n{"key":"value"}\n```\nDone.';
    expect(parseJsonResponse(input)).toEqual({ key: 'value' });
  });

  it('extracts JSON from code block without json tag', () => {
    const input = '```\n[1,2,3]\n```';
    expect(parseJsonResponse(input)).toEqual([1, 2, 3]);
  });

  it('extracts JSON array from response body (no code block)', () => {
    const input = 'The actions are: [{"type":"text","content":"hello"}]';
    const result = parseJsonResponse<Array<{ type: string; content: string }>>(input);
    expect(result).toEqual([{ type: 'text', content: 'hello' }]);
  });

  it('extracts JSON object from response body', () => {
    const input = 'Result: {"name":"test","value":42} end';
    expect(parseJsonResponse(input)).toEqual({ name: 'test', value: 42 });
  });

  it('handles nested brackets correctly', () => {
    const input = '[{"arr":[1,2],"obj":{"a":"b"}}]';
    expect(parseJsonResponse(input)).toEqual([{ arr: [1, 2], obj: { a: 'b' } }]);
  });

  it('handles strings containing brackets', () => {
    const input = '{"text":"array [1,2] and obj {a:b}"}';
    expect(parseJsonResponse(input)).toEqual({ text: 'array [1,2] and obj {a:b}' });
  });

  it('prefers code block over body extraction', () => {
    const input = 'prefix {"wrong":true}\n```json\n{"right":true}\n```';
    expect(parseJsonResponse(input)).toEqual({ right: true });
  });

  it('falls back to raw response when no structure found', () => {
    const input = '{"direct":"json"}';
    expect(parseJsonResponse(input)).toEqual({ direct: 'json' });
  });

  it('returns non-null for plain text (jsonrepair fallback)', () => {
    // jsonrepair can recover even plain text, so parseJsonResponse rarely returns null
    const result = parseJsonResponse('Hello this is just text');
    expect(result).not.toBeNull();
  });

  it('handles multiple code blocks and picks the first valid one', () => {
    const input = '```json\nnot valid\n```\n```json\n{"valid":true}\n```';
    expect(parseJsonResponse(input)).toEqual({ valid: true });
  });

  it('handles escaped quotes inside JSON strings', () => {
    const input = '{"text":"he said \\"hello\\""}';
    expect(parseJsonResponse(input)).toEqual({ text: 'he said "hello"' });
  });
});
