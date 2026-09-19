import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from '@/lib/server/http-range';

describe('parseRangeHeader', () => {
  it('ignores a missing header', () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: 'ignored' });
  });

  it('ignores unsupported units and multi-range sets', () => {
    expect(parseRangeHeader('items=0-9', 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('bytes=0-9,20-29', 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('bytes=-', 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('bytes=abc-def', 100)).toEqual({ kind: 'ignored' });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=10-', 100)).toEqual({ kind: 'range', start: 10, end: 99 });
  });

  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ kind: 'range', start: 10, end: 19 });
  });

  it('clamps an end beyond the representation size', () => {
    expect(parseRangeHeader('bytes=0-999', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-20', 100)).toEqual({ kind: 'range', start: 80, end: 99 });
  });

  it('clamps a suffix range larger than the representation', () => {
    expect(parseRangeHeader('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('rejects a start beyond the end of the representation', () => {
    expect(parseRangeHeader('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=500-600', 100)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects an inverted range and a zero-length suffix', () => {
    expect(parseRangeHeader('bytes=50-40', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects any range against an empty representation', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
