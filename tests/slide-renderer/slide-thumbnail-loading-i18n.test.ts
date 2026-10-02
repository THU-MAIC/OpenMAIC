import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../components/slide-renderer/SlideThumbnail.tsx',
  ),
  'utf8',
);

describe('SlideThumbnail lazy placeholder i18n', () => {
  it('uses common.loading instead of hardcoded Chinese', () => {
    expect(source).toContain("t('common.loading')");
    expect(source).not.toMatch(/加载中/);
  });
});
