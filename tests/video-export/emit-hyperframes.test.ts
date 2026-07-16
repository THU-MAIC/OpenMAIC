import { describe, it, expect } from 'vitest';
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

const audioMeta = (id: string): AssetMeta => ({
  id,
  format: 'mp3',
  present: true,
  durationMs: 2000,
});
const videoMeta = (id: string): AssetMeta => ({ id, format: 'mp4', present: true });

/** A slide classroom exercising every emitted layer: base, narration, effects, video. */
function compileSample() {
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
  return compileVideoTimeline(
    { stage: { id: 'stage', name: 'Sample Lesson' }, scenes },
    {
      timing: stubProbe({ sp1: 2000 }, { v1: 3000 }),
      assets: stubAssets({ sp1: audioMeta('a1') }, { e1: videoMeta('stage:e1') }),
    },
  );
}

describe('emitHyperframes', () => {
  const ir = compileSample();
  const project = emitHyperframes(ir, { width: 1920, height: 1080 });
  const html = project.files.find((f) => f.path === 'index.html')!.content;

  it('emits the self-contained project file set', () => {
    const paths = project.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        'README.md',
        'index.html',
        'openmaic-video-manifest.json',
        'subtitles.srt',
        'subtitles.vtt',
      ].sort(),
    );
  });

  it('builds one composition driven by one paused GSAP timeline', () => {
    expect(html).toContain('data-composition-id="openmaic"');
    expect(html).toContain('data-width="1920"');
    expect(html).toContain('data-height="1080"');
    expect(html).toContain(`data-duration="${ir.totalDurationMs / 1000}"`);
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('window.__timelines["openmaic"] = tl;');
  });

  it('lays out base / narration / video clips with clip attributes', () => {
    expect(html).toMatch(/<img [^>]*class="clip"[^>]*src="assets\/frames\/[^"]+\.png"/);
    expect(html).toMatch(/<audio [^>]*class="clip"[^>]*src="assets\/audio\/[^"]+"/);
    expect(html).toMatch(/<video [^>]*class="clip"[^>]*src="assets\/media\/[^"]+"/);
    // the unsupported quiz scene becomes a placeholder card, not a frame img
    expect(html).toContain('position:absolute;inset:0;display:flex');
  });

  it('emits spotlight and laser overlays with authored params', () => {
    expect(html).toContain('class="fx fx-spotlight"');
    expect(html).toContain('class="fx fx-laser"');
    expect(html).toContain('#00ff88'); // authored laser color survives into the DOM
  });

  it('references vendored GSAP, never a CDN', () => {
    expect(html).toContain('<script src="assets/vendor/gsap.min.js"></script>');
    expect(project.gsapVendorPath).toBe('assets/vendor/gsap.min.js');
  });

  it('matches the HTML snapshot', () => {
    expect(html).toMatchSnapshot();
  });
});

describe('emitHyperframes determinism red-lines (hyperframes lint proxy)', () => {
  const project = emitHyperframes(compileSample());
  const html = project.files.find((f) => f.path === 'index.html')!.content;

  it('loads no script or asset from an http(s) origin (no CDN)', () => {
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it('uses no non-deterministic runtime APIs', () => {
    expect(html).not.toContain('Date.now');
    expect(html).not.toContain('Math.random');
    expect(html).not.toContain('requestAnimationFrame');
    expect(html).not.toContain('setTimeout');
    expect(html).not.toContain('setInterval');
  });

  it('uses no infinite repeats (finite ring pulse only)', () => {
    expect(html).not.toContain('repeat:-1');
    expect(html).not.toContain('repeat: -1');
    expect(html).not.toContain('Infinity');
  });

  it('declares an explicit root duration and extends the timeline to it', () => {
    expect(html).toMatch(/data-duration="[\d.]+"/);
    expect(html).toMatch(/tl\.set\(\{\}, \{\}, [\d.]+\);/);
  });
});
