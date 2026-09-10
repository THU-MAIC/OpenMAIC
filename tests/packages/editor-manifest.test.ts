import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const editorPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../packages/@openmaic/editor/package.json', import.meta.url)),
    'utf8',
  ),
) as {
  repository?: { type?: string; url?: string; directory?: string };
};

describe('@openmaic/editor publish manifest', () => {
  it('declares provenance repository metadata', () => {
    expect(editorPackage.repository).toEqual({
      type: 'git',
      url: 'https://github.com/THU-MAIC/OpenMAIC',
      directory: 'packages/@openmaic/editor',
    });
  });
});
