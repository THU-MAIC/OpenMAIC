import { describe, expect, it } from 'vitest';

import { OPENMAIC_GITHUB_REPO, formatStarCount } from '@/lib/workbench/github-stars';

describe('formatStarCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12000, '12k'],
    [12400, '12.4k'],
    [123456, '123.5k'],
    [1_250_000, '1.3m'],
  ])('formats %d as %s', (stars, expected) => {
    expect(formatStarCount(stars)).toBe(expected);
  });
});

describe('OPENMAIC_GITHUB_REPO', () => {
  it('is the owner/repo pair of the public repository URL', () => {
    expect(OPENMAIC_GITHUB_REPO).toBe('THU-MAIC/OpenMAIC');
  });
});
