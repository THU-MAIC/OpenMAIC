import { describe, expect, it } from 'vitest';
import { isMediaPlaceholder } from '@/lib/store/media-generation';

describe('isMediaPlaceholder', () => {
  it.each([
    ['gen_img_1', true],
    ['gen_vid_any-value', true],
    ['ast_arbitrary-opaque-id', true],
    ['tts_s2_action_1', true],
    ['another-provider-ref', true],
    ['logo.png', true],
    ['file:///tmp/logo.png', true],
    ['C:\\media\\logo.png', true],
    [' https://example.test/leading-space.png', true],
    ['http://example.test/image.png', false],
    ['https://example.test/video.mp4', false],
    ['data:image/png;base64,AA==', false],
    ['blob:browser-object-url', false],
    ['/absolute/path.png', false],
    ['./relative.png', false],
    ['../parent-relative.png', false],
    ['', false],
  ])('classifies %j as %s', (src, expected) => {
    expect(isMediaPlaceholder(src)).toBe(expected);
  });
});
