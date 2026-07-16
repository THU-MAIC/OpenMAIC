import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import type { AssetMeta } from '@/lib/video-export';
import {
  slide,
  quiz,
  el,
  speech,
  spotlight,
  laser,
  playVideo,
  stubProbe,
  stubAssets,
} from './helpers';

/**
 * Materializes a fully-emitted Hyperframes project (index.html + manifest +
 * subtitles + README + synthetic asset bytes + vendored GSAP) to a directory so
 * the real `npx hyperframes lint/render` CLI can be run against it by hand:
 *
 *   HF_E2E_DIR=/tmp/hf-e2e npx vitest run tests/video-export/e2e-materialize.test.ts
 *   cd /tmp/hf-e2e && npx hyperframes lint
 *
 * Skipped unless HF_E2E_DIR is set, so it never runs in normal CI.
 */
const OUT_DIR = process.env.HF_E2E_DIR;

// 1x1 transparent PNG — a valid image so a lint/render doesn't choke on the frame.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const audioMeta = (id: string): AssetMeta => ({
  id,
  format: 'mp3',
  present: true,
  durationMs: 2000,
});
const videoMeta = (id: string): AssetMeta => ({ id, format: 'mp4', present: true });

describe.skipIf(!OUT_DIR)('materialize a Hyperframes project for real-CLI E2E', () => {
  it('writes a complete, self-contained project', () => {
    const dir = OUT_DIR!;
    const scenes = [
      slide(
        'intro',
        [
          speech('sp1', 'Welcome to the lesson', { audioId: 'a1' }),
          spotlight('l1', 'e1'),
          laser('la1', 'e1', '#00ff88'),
          playVideo('v1', 'e1'),
        ],
        { title: 'Intro', elements: [el('e1', { left: 250, top: 140, width: 500, height: 280 })] },
      ),
      quiz('checkpoint', [], 1),
    ];
    const ir = compileVideoTimeline(
      { stage: { id: 'stage', name: 'E2E Lesson' }, scenes },
      {
        timing: stubProbe({ sp1: 2000 }, { v1: 3000 }),
        assets: stubAssets({ sp1: audioMeta('a1') }, { e1: videoMeta('stage:e1') }),
      },
    );
    const project = emitHyperframes(ir, { width: 1280, height: 720 });

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Emitted text files.
    for (const file of project.files) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }

    // Synthetic asset bytes for every present plan entry (frames get a real PNG).
    for (const entry of ir.assets.entries) {
      if (!entry.present || entry.dedupOf) continue;
      const target = join(dir, 'assets', entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.kind === 'frame' ? PNG_1x1 : Buffer.from(''));
    }

    // Vendored GSAP from the committed public copy.
    const gsapSrc = join(process.cwd(), 'public/vendor/gsap.min.js');
    const gsapDst = join(dir, project.gsapVendorPath);
    mkdirSync(dirname(gsapDst), { recursive: true });
    cpSync(gsapSrc, gsapDst);

    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    expect(existsSync(gsapDst)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`\n[hf-e2e] project written to ${dir}\n  cd ${dir} && npx hyperframes lint\n`);
  });
});
