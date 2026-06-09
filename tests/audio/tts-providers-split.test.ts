import { describe, expect, it } from 'vitest';
import { splitConcatenatedJsonObjects } from '@/lib/audio/tts-providers';

describe('splitConcatenatedJsonObjects', () => {
  it('returns an empty array for empty or object-free input', () => {
    expect(splitConcatenatedJsonObjects('')).toEqual([]);
    expect(splitConcatenatedJsonObjects('no json here')).toEqual([]);
  });

  it('extracts a single object', () => {
    expect(splitConcatenatedJsonObjects('{"code":0}')).toEqual(['{"code":0}']);
  });

  it('splits two concatenated objects with no delimiter', () => {
    const out = splitConcatenatedJsonObjects('{"code":0,"data":"a"}{"code":20000000}');
    expect(out).toEqual(['{"code":0,"data":"a"}', '{"code":20000000}']);
    expect(out.map((o) => JSON.parse(o))).toEqual([{ code: 0, data: 'a' }, { code: 20000000 }]);
  });

  it('does not split on a brace inside a string value (regression #676)', () => {
    const out = splitConcatenatedJsonObjects('{"code":1,"message":"bad {input}"}');
    expect(out).toEqual(['{"code":1,"message":"bad {input}"}']);
    expect(JSON.parse(out[0])).toEqual({ code: 1, message: 'bad {input}' });
  });

  it('keeps following objects aligned after a brace-in-string object', () => {
    const text = '{"code":1,"message":"oops }{"}{"code":0,"data":"xyz"}';
    const out = splitConcatenatedJsonObjects(text);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0])).toEqual({ code: 1, message: 'oops }{' });
    expect(JSON.parse(out[1])).toEqual({ code: 0, data: 'xyz' });
  });

  it('handles escaped quotes inside string values', () => {
    const text = '{"message":"he said \\"{hi}\\""}{"code":0}';
    const out = splitConcatenatedJsonObjects(text);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0])).toEqual({ message: 'he said "{hi}"' });
    expect(JSON.parse(out[1])).toEqual({ code: 0 });
  });

  it('treats nested objects as a single top-level object', () => {
    const text = '{"a":{"b":{"c":1}}}{"d":2}';
    const out = splitConcatenatedJsonObjects(text);
    expect(out).toEqual(['{"a":{"b":{"c":1}}}', '{"d":2}']);
  });

  it('ignores leading/trailing noise and stray closers', () => {
    expect(splitConcatenatedJsonObjects('}}{"code":0}xx')).toEqual(['{"code":0}']);
  });
});
