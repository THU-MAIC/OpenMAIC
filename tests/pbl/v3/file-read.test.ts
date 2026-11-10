import { describe, expect, it } from 'vitest';
import { readProjectFileExcerpt } from '@/lib/server/pbl-v3/file-read';

describe('PBL file excerpts', () => {
  it('preserves the result shape and exact text for an ordinary small file', () => {
    expect(readProjectFileExcerpt('public class Main {}\n')).toEqual({
      text: 'public class Main {}\n',
    });
  });

  it.each(['\ufeff' + '中文🙂\r\n'.repeat(4_000), '\ufeff' + '🙂学'.repeat(4_000)])(
    'returns bounded excerpts that reconstruct the original file',
    (source) => {
      let offset = 0;
      const pages = [];
      for (;;) {
        const excerpt = readProjectFileExcerpt(source, { offset });
        expect(Buffer.byteLength(excerpt.text)).toBeLessThanOrEqual(8192);
        pages.push(excerpt.text);
        if (excerpt.nextOffset === undefined) break;
        expect(excerpt.nextOffset).toBe(offset + excerpt.text.length);
        expect(excerpt.nextOffset).toBeGreaterThan(offset);
        offset = excerpt.nextOffset;
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join('')).toBe(source);
    },
  );

  it('reads an inclusive line range and preserves exact line endings', () => {
    const source = 'first\r\nsecond🙂\r\nthird\nlast';
    expect(readProjectFileExcerpt(source, { startLine: 2, endLine: 3 })).toEqual({
      text: 'second🙂\r\nthird\n',
      offset: 'first\r\n'.length,
    });
    expect(readProjectFileExcerpt(source, { startLine: 4, endLine: 4 }).text).toBe('last');
    expect(() => readProjectFileExcerpt(source, { startLine: 5 })).toThrow('valid startLine');
    expect(() => readProjectFileExcerpt(source, { startLine: 3, endLine: 2 })).toThrow(
      'valid startLine',
    );
  });

  it('can continue a long line range without reading beyond its requested end', () => {
    const body = '中文🙂'.repeat(3_000) + '\n';
    const source = 'before\n' + body + 'after';
    let page = readProjectFileExcerpt(source, { startLine: 2, endLine: 2 });
    let result = page.text;
    while (page.nextOffset !== undefined) {
      page = readProjectFileExcerpt(source, { offset: page.nextOffset, endLine: 2 });
      result += page.text;
    }
    expect(result).toBe(body);
  });

  it('rejects offsets past the end or inside a surrogate pair', () => {
    expect(() => readProjectFileExcerpt('hello', { offset: 6 })).toThrow('valid file offset');
    expect(() => readProjectFileExcerpt('🙂', { offset: 1 })).toThrow('valid file offset');
  });
});
