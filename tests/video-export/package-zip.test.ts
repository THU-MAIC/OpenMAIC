import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { packageVideoZip } from '@/lib/video-export-app/package-zip';

describe('packageVideoZip — interactive HTML', () => {
  it('writes the prepared page under assets/interactive in the self-contained ZIP', async () => {
    const blob = await packageVideoZip(
      {
        files: [{ path: 'index.html', content: '<!doctype html><main>composition</main>' }],
        width: 1280,
        height: 720,
        compositionId: 'openmaic',
        totalDurationMs: 1000,
        gsapVendorPath: 'assets/vendor/gsap.min.js',
      },
      new Map([
        [
          'interactive/001-widget.html',
          new Blob(['<!doctype html><h1>Frozen widget</h1>'], { type: 'text/html' }),
        ],
      ]),
      { gsapSource: 'window.gsap={};' },
    );

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await zip.file('assets/interactive/001-widget.html')?.async('string')).toContain(
      'Frozen widget',
    );
    expect(await zip.file('index.html')?.async('string')).toContain('composition');
    expect(await zip.file('assets/vendor/gsap.min.js')?.async('string')).toContain('window.gsap');
  });
});
