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
        const excerpt = readProjectFileExcerpt(source, offset);
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

  it('rejects offsets past the end or inside a surrogate pair', () => {
    expect(() => readProjectFileExcerpt('hello', 6)).toThrow('valid file offset');
    expect(() => readProjectFileExcerpt('🙂', 1)).toThrow('valid file offset');
  });
});
