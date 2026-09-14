/**
 * A reference the pool never issued is not worth asking the pool about.
 *
 * Every id this application stores comes from `putAsset`, and the pool answers
 * with an `ast_`-prefixed id — so anything else (a `gen_img_*` placeholder, a
 * derived narration key, an imported `nanoid()`) was never in the pool. Once
 * the pool is server-backed, asking anyway is a real
 * `GET /assets/<ref>/content` that answers 404: one wasted request per element,
 * repeated on every load, forever on a course that still holds placeholders.
 *
 * The predicate is unit-tested here, the four slots of a slide are covered
 * behaviourally, and every remaining lease and probe entry point is checked for
 * the guard — because a site that forgets it renders correctly and nothing
 * else fails.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Slide } from '@openmaic/dsl';

import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { poolLeasableSlideRefs } from '@/components/slide-renderer/use-resolved-slide';

describe('references the pool cannot hold', () => {
  it.each([
    'gen_img_1',
    'gen_img_CiZDrJ-a',
    'gen_vid_abc123',
    'GEN_IMG_UPPER',
    'tts_s2_speech-1',
    'tts_s-1_speech-1',
    'tts_request_s2_speech-1',
    // What an import mints. Imported bytes go to the local media tables and
    // never to the pool, in either persistence mode.
    'V1StGXR8_Z5jdHi6B-myT',
    'ttsentity',
    'tts_speech-1',
    'generated-image-7',
    'https://cdn.example.com/image.png',
    'astro_1',
    'AST_UPPER',
  ])('does not ask the pool about %s', (ref) => {
    expect(mayNameAPoolAsset(ref)).toBe(false);
  });

  it.each(['ast_t1h2w7xf9d', 'ast_opaque_1', 'ast_'])('asks the pool about %s', (ref) => {
    expect(mayNameAPoolAsset(ref)).toBe(true);
  });

  it('treats an absent reference as nothing to ask about', () => {
    expect(mayNameAPoolAsset(undefined)).toBe(false);
    expect(mayNameAPoolAsset('')).toBe(false);
  });
});

// A slide carries media in four places, and each of them opens its own lease.
// The rule is checked here rather than by counting guard call sites, so a
// fifth slot added later is covered by whatever this asserts about the others.
describe('a slide leases only what the pool could hold', () => {
  function slideWith(source: string, poster: string, background: string): Slide {
    return {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      background: { type: 'image', image: { src: background, size: 'cover' } },
      theme: {
        fontName: 'Arial',
        fontColor: '#111111',
        backgroundColor: '#ffffff',
        themeColors: ['#111111'],
      },
      elements: [
        {
          id: 'image-1',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          fixedRatio: true,
          src: source,
        },
        {
          id: 'video-1',
          type: 'video',
          left: 0,
          top: 0,
          width: 100,
          height: 56,
          rotate: 0,
          src: source,
          poster,
          autoplay: false,
        },
      ],
    };
  }

  it('opens no lease for a course that still holds placeholders', () => {
    const refs = poolLeasableSlideRefs(
      slideWith('gen_img_1', 'gen_img_2', 'gen_img_3'),
      'stage-1',
      {},
    );
    expect(refs).toEqual([]);
  });

  it('opens no lease for references an import minted', () => {
    const refs = poolLeasableSlideRefs(
      slideWith('V1StGXR8_Z5jdHi6B-myT', 'nZ9-tPqRk1', 'aB3cD4eF5g'),
      'stage-1',
      {},
    );
    expect(refs).toEqual([]);
  });

  it('leases every slot once the references are allocated', () => {
    const refs = poolLeasableSlideRefs(
      slideWith('ast_source', 'ast_poster', 'ast_background'),
      'stage-1',
      {},
    );
    expect(refs).toEqual(['ast_source', 'ast_source', 'ast_poster', 'ast_background']);
  });

  it('leaves a concrete address to resolve itself', () => {
    const refs = poolLeasableSlideRefs(
      slideWith('https://example.test/i.png', 'data:image/png;base64,AA', 'blob:local'),
      'stage-1',
      {},
    );
    expect(refs).toEqual([]);
  });

  it('opens no lease at all without a stage', () => {
    expect(poolLeasableSlideRefs(slideWith('ast_a', 'ast_b', 'ast_c'), undefined, {})).toEqual([]);
  });
});

// No component-render harness exists for the remaining sites, so their wiring
// is checked statically.
describe('every lease and probe entry point carries the guard', () => {
  const GUARDED = [
    'components/slide-renderer/use-resolved-slide.ts',
    'lib/audio/regenerate-speech-tts.ts',
    'lib/media/resolve-audio-bytes.ts',
    'lib/media/resolve-media-ref.ts',
    'lib/media/resolve-stored-bytes.ts',
    'lib/utils/stage-storage.ts',
  ];

  it.each(GUARDED)('%s guards before it asks the pool', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).toContain('mayNameAPoolAsset');
  });

  it('names every module that reaches the pool, so a new one cannot be missed', () => {
    // The entry points are whatever the lease module exports, read from the
    // module itself rather than listed here: a helper added later is part of
    // this enumeration the moment it exists, which a hand-written list of four
    // or five names is not. Substring matching makes the pattern a superset
    // (`useAssetUrl` also matches `useAssetUrlLeases`), which is the safe
    // direction — an extra hit fails this test and gets looked at.
    const leaseModule = 'lib/media/use-asset-url.ts';
    const exported = [
      ...readFileSync(join(process.cwd(), leaseModule), 'utf8').matchAll(
        /^export (?:async )?function (\w+)/gm,
      ),
    ].map((match) => match[1]);
    expect(exported.length).toBeGreaterThan(4);

    // `packages/` is searched too: a package that grew an application import
    // would be an entry point nobody thought to look for.
    const roots = ['app', 'components', 'lib', 'packages'];
    const hits = execSync(
      `grep -rlE --exclude-dir=node_modules "${exported.join('|')}" ${roots.join(' ')} || true`,
      { cwd: process.cwd(), encoding: 'utf8' },
    )
      .split('\n')
      .filter(
        (line) =>
          line &&
          !line.includes('/dist/') &&
          // Owns the leases; guarding inside it would be circular.
          !line.endsWith(leaseModule) &&
          // Publishes invalidations after a replacement. It never opens a
          // lease, and the pool is where replacements are observed.
          !line.endsWith('lib/media/asset-pool.ts'),
      )
      .sort();

    expect(hits).toEqual(GUARDED.slice().sort());
  });
});
