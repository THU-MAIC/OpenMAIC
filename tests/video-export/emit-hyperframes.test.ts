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

  it('burns in a subtitle overlay driven by the timeline', () => {
    // A caption container plus one cue div per non-empty speech action.
    expect(html).toContain('id="subtitles"');
    expect(html).toContain('id="subtitle-cue-0"');
    // Cues start hidden (display:none, out of layout) and are toggled by the
    // paused timeline — see the multi-cue positioning test below for why
    // display (not visibility) matters.
    expect(html).toMatch(/id="subtitle-cue-0"[^>]*display:none/);
    expect(html).toMatch(/tl\.set\('#subtitle-cue-0',\{display:'inline-block'\},[\d.]+\);/);
    expect(html).toMatch(/tl\.set\('#subtitle-cue-0',\{display:'none'\},[\d.]+\);/);
    // Narration text is rendered into the caption.
    expect(html).toContain('Welcome to the lesson');
  });

  it('references vendored GSAP, never a CDN', () => {
    expect(html).toContain('<script src="assets/vendor/gsap.min.js"></script>');
    expect(project.gsapVendorPath).toBe('assets/vendor/gsap.min.js');
  });

  it('matches the HTML snapshot', () => {
    expect(html).toMatchSnapshot();
  });
});

describe('emitHyperframes multi-cue subtitle positioning (regression)', () => {
  // A scene with several narration cues; the earlier cut left inactive cues in
  // layout (visibility:hidden + inline-block), so the band grew multiple rows
  // tall and the active cue drifted up into the slide/title area.
  const ir = compileVideoTimeline(
    {
      stage: { id: 'stage', name: 'Multi Cue' },
      scenes: [
        slide(
          'intro',
          [
            speech('sp1', 'First caption line', { audioId: 'a1' }),
            speech('sp2', 'Second caption line', { audioId: 'a2' }),
            speech('sp3', 'Third caption line', { audioId: 'a3' }),
          ],
          { title: 'Intro', elements: [] },
        ),
      ],
    },
    {
      timing: stubProbe({ sp1: 2000, sp2: 2000, sp3: 2000 }, {}),
      assets: stubAssets({ sp1: audioMeta('a1'), sp2: audioMeta('a2'), sp3: audioMeta('a3') }, {}),
    },
  );
  const html = emitHyperframes(ir, { width: 1920, height: 1080 }).files.find(
    (f) => f.path === 'index.html',
  )!.content;

  it('stacks every cue in one grid cell so the active cue never shifts', () => {
    // All cues share grid-area 1/1 — one slot, not one row each.
    const cueCount = (html.match(/id="subtitle-cue-\d+"/g) ?? []).length;
    expect(cueCount).toBe(3);
    expect(html.match(/grid-area:1\/1/g)?.length).toBe(3);
    expect(html).toContain('id="subtitles" style="position:absolute');
    // The container is a grid so the single occupied cell owns the whole band.
    expect(html).toMatch(/id="subtitles"[^>]*display:grid/);
  });

  it('removes inactive cues from layout (display:none, never visibility:hidden)', () => {
    // Every cue starts display:none; toggled cues use display, not visibility —
    // a visibility-hidden cue would keep its box and push the active one out of slot.
    for (let i = 0; i < 3; i++) {
      expect(html).toMatch(new RegExp(`id="subtitle-cue-${i}"[^>]*display:none`));
      expect(html).toContain(`tl.set('#subtitle-cue-${i}',{display:'inline-block'}`);
      expect(html).toContain(`tl.set('#subtitle-cue-${i}',{display:'none'}`);
    }
    expect(html).not.toContain('visibility:hidden');
    expect(html).not.toContain("visibility:'hidden'");
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
