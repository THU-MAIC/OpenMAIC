import { describe, expect, it } from 'vitest';
import { buildVisionUserContent, parseBase64DataUrl } from '@openmaic/generation';

describe('base64 data URLs', () => {
  it.each(['image/png', 'image/jpeg'])('parses %s and builds an image part', (mimeType) => {
    const src = `data:${mimeType};base64,aGVsbG8=`;
    expect(parseBase64DataUrl(src)).toEqual({ mimeType, base64: 'aGVsbG8=' });
    expect(buildVisionUserContent('prompt', [{ id: 'image', src }]).at(-1)).toEqual({
      type: 'image',
      image: 'aGVsbG8=',
      mimeType,
    });
  });

  it('reads the MIME type before optional header parameters', () => {
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,YQ==')).toEqual({
      mimeType: 'image/png',
      base64: 'YQ==',
    });
  });

  it('parses and builds a prompt with an 8 MiB payload without throwing', () => {
    const base64 = 'A'.repeat(8 * 1024 * 1024);
    const src = `data:image/png;base64,${base64}`;
    expect(parseBase64DataUrl(src)).toEqual({ mimeType: 'image/png', base64 });
    expect(buildVisionUserContent('prompt', [{ id: 'large', src }]).at(-1)).toEqual({
      type: 'image',
      image: base64,
      mimeType: 'image/png',
    });
  });

  it.each([
    '',
    'https://example.org/image.png',
    'http://example.org/image.jpg',
    'data:image/png,plain',
    'data:image/png;base64',
    'data:;base64,YQ==',
    'data:image/png;base64,',
    'data:image/png;base64;extra,YQ==',
    'image/png;base64,YQ==',
  ])('passes through a non-base64 or malformed URL: %s', (src) => {
    expect(parseBase64DataUrl(src)).toBeNull();
    expect(buildVisionUserContent('prompt', [{ id: 'image', src }]).at(-1)).toEqual({
      type: 'image',
      image: src,
    });
  });
});
