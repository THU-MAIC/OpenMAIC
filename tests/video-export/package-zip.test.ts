import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { EmittedProject } from '@/lib/video-export';
import { packageVideoZip } from '@/lib/video-export-app/package-zip';

function project(vendorAssets: EmittedProject['vendorAssets']): EmittedProject {
  return {
    files: [{ path: 'index.html', content: '<!doctype html>' }],
    width: 1280,
    height: 720,
    compositionId: 'openmaic',
    totalDurationMs: 1000,
    gsapVendorPath: 'assets/vendor/gsap.min.js',
    vendorAssets,
  };
}

describe('packageVideoZip — interactive HTML', () => {
  it('writes the prepared page under assets/interactive in the self-contained ZIP', async () => {
    const blob = await packageVideoZip(
      {
        ...project([]),
        files: [{ path: 'index.html', content: '<!doctype html><main>composition</main>' }],
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

describe('video-export ZIP vendor assets', () => {
  it('fetches and packages only the binary assets declared by the emitted project', async () => {
    const loadVendorAsset = vi.fn(async (sourceUrl: string) => {
      expect(sourceUrl).toBe('/vendor/video-export/fonts/quiz-font.woff2');
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'font/woff2' });
    });

    const blob = await packageVideoZip(
      project([
        {
          path: 'assets/fonts/quiz-font.woff2',
          sourceUrl: '/vendor/video-export/fonts/quiz-font.woff2',
        },
      ]),
      new Map(),
      { gsapSource: '/* gsap */', loadVendorAsset },
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(loadVendorAsset).toHaveBeenCalledTimes(1);
    expect(await zip.file('assets/fonts/quiz-font.woff2')!.async('uint8array')).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('does not fetch font assets for a project that declares none', async () => {
    const loadVendorAsset = vi.fn();

    await packageVideoZip(project([]), new Map(), {
      gsapSource: '/* gsap */',
      loadVendorAsset,
    });

    expect(loadVendorAsset).not.toHaveBeenCalled();
  });
});
