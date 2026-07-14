import { describe, expect, it } from 'vitest';
import { extractOriginalImageId } from '@/lib/utils/image-storage';

describe('extractOriginalImageId', () => {
  it('extracts an image id from a normal session storage id', () => {
    expect(extractOriginalImageId('session_abc123def4_img_15')).toBe('img_15');
  });

  it('does not truncate a nanoid containing underscores', () => {
    expect(extractOriginalImageId('session_ab_cd_efgh_img_20')).toBe('img_20');
  });

  it('preserves nonnumeric image ids', () => {
    expect(extractOriginalImageId('session_abc123def4_img_data')).toBe('img_data');
  });

  it('preserves image ids containing an image-like delimiter', () => {
    expect(extractOriginalImageId('session_abc123def4_hero_img_1')).toBe('hero_img_1');
  });

  it('rejects malformed storage ids', () => {
    expect(extractOriginalImageId('session_abc123')).toBeUndefined();
    expect(extractOriginalImageId('session_abc123def4_')).toBeUndefined();
    expect(extractOriginalImageId('other_abc123def4_img_1')).toBeUndefined();
  });
});
