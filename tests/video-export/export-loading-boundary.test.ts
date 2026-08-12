import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('video-export client loading boundary', () => {
  it('keeps the Quiz export implementation behind user-triggered dynamic imports', () => {
    const clientEntries = [
      'components/stage/video-export-dialog.tsx',
      'lib/store/video-render.ts',
      'lib/video-export-app/use-export-video.ts',
      'lib/video-export-app/use-download-subtitles.ts',
    ];

    for (const path of clientEntries) {
      expect(source(path), `${path} must not eagerly import the export compiler`).not.toMatch(
        /from\s+['"][^'"]*build-export-zip['"]/,
      );
    }

    expect(source('lib/store/video-render.ts')).toContain(
      "await import('@/lib/video-export-app/build-export-zip')",
    );
    expect(source('lib/video-export-app/use-export-video.ts')).toContain(
      "await import('./build-export-zip')",
    );
    expect(source('lib/video-export-app/use-download-subtitles.ts')).toContain(
      "await import('./build-export-zip')",
    );
  });
});
