import { describe, expect, it } from 'vitest';

import { splitConcatenatedJsonObjects } from '@/lib/audio/json-stream';

describe('splitConcatenatedJsonObjects', () => {
  it('splits a delimiter-less run of objects', () => {
    expect(splitConcatenatedJsonObjects('{"a":1}{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does NOT split on a brace inside a string value (the bug)', () => {
    const stream = '{"code":0,"data":"x"}{"code":1,"message":"bad {input}"}';
    expect(splitConcatenatedJsonObjects(stream)).toEqual([
      '{"code":0,"data":"x"}',
      '{"code":1,"message":"bad {input}"}',
    ]);
  });

  it('respects escaped quotes and braces inside strings', () => {
    const stream = '{"m":"a \\" } { b"}{"n":2}';
    const parts = splitConcatenatedJsonObjects(stream);
    expect(parts).toHaveLength(2);
    expect(JSON.parse(parts[0])).toEqual({ m: 'a " } { b' });
    expect(JSON.parse(parts[1])).toEqual({ n: 2 });
  });

  it('handles nested objects', () => {
    expect(splitConcatenatedJsonObjects('{"a":{"b":1}}{"c":2}')).toEqual([
      '{"a":{"b":1}}',
      '{"c":2}',
    ]);
  });

  it('drops an unbalanced trailing object', () => {
    expect(splitConcatenatedJsonObjects('{"a":1}{"b":')).toEqual(['{"a":1}']);
  });

  it('returns [] for empty or non-object input', () => {
    expect(splitConcatenatedJsonObjects('')).toEqual([]);
    expect(splitConcatenatedJsonObjects('not json')).toEqual([]);
  });
});
