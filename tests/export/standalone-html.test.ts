import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  prepareScenes: vi.fn(),
  buildAssetManifest: vi.fn(),
  collectAudioFiles: vi.fn(),
  collectMediaFiles: vi.fn(),
  collectLegacyAudioForExport: vi.fn(),
  collectVideoPosters: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: mocks.prepareScenes,
}));
vi.mock('@/lib/media/asset-manifest', () => ({
  buildStageAssetManifest: mocks.buildAssetManifest,
}));
vi.mock('@/lib/export/classroom-zip-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/classroom-zip-utils')>();
  return {
    ...actual,
    collectAudioFiles: mocks.collectAudioFiles,
    collectMediaFiles: mocks.collectMediaFiles,
    collectLegacyAudioForExport: mocks.collectLegacyAudioForExport,
    collectVideoPosters: mocks.collectVideoPosters,
  };
});

import {
  buildStandaloneHtmlExport,
  resolvePublicClassroomUrl,
  type StandaloneHtmlExportOptions,
} from '@/lib/export/standalone-html/build-standalone-html';
import {
  STANDALONE_HTML_CSP,
  assembleStandaloneHtml,
  serializeJsonForHtmlScript,
} from '@/lib/export/standalone-html/assemble';
import {
  STANDALONE_CONFIG_ELEMENT_ID,
  STANDALONE_INTERACTIVE_SANDBOX,
  STANDALONE_MANIFEST_ELEMENT_ID,
  STANDALONE_PLAYER_ASSETS,
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerConfig,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';
import { prepareStandaloneManifest } from '@/lib/export/standalone-html/prepare-manifest';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import type { Scene } from '@/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import { legacyPBLSceneFixture } from '../fixtures/pbl-v1-scene';
import {
  DEFAULT_FIXTURE_MEDIA,
  FIXTURE_PNG_BASE64,
  standaloneFixtureScenes,
  standaloneFixtureStage,
} from '../fixtures/standalone-html-classroom';

const STAGE_ID = 'stage-standalone';
const PNG_BYTES = Uint8Array.from(Buffer.from(FIXTURE_PNG_BASE64, 'base64'));
const PLAYER_SCRIPT = 'window.__player = true;';
const PLAYER_STYLE = 'body{margin:0}';
const MATH_FONTS = '@font-face{font-family:KaTeX_Main}';
const CHARTS_SCRIPT = 'window.__charts = true;';

const strings = Object.fromEntries(
  STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, `[${key}]`]),
) as StandalonePlayerStrings;

const fetchAsset = vi.fn(async (assetPath: string) => {
  switch (assetPath) {
    case STANDALONE_PLAYER_ASSETS.script:
      return PLAYER_SCRIPT;
    case STANDALONE_PLAYER_ASSETS.style:
      return PLAYER_STYLE;
    case STANDALONE_PLAYER_ASSETS.mathFonts:
      return MATH_FONTS;
    case STANDALONE_PLAYER_ASSETS.charts:
      return CHARTS_SCRIPT;
    default:
      throw new Error(`unexpected asset ${assetPath}`);
  }
});
const fetchImage = vi.fn(async (url: string) =>
  url === DEFAULT_FIXTURE_MEDIA.remoteImageUrl
    ? new Blob([PNG_BYTES], { type: 'image/png' })
    : null,
);

function setupSnapshot(scenes: Scene[]) {
  const stage = standaloneFixtureStage(STAGE_ID);
  mocks.accessDocument.mockResolvedValue({ document: { stage } });
  mocks.prepareScenes.mockResolvedValue(scenes);
  mocks.buildAssetManifest.mockResolvedValue({
    entries: [{ kind: 'image', ref: DEFAULT_FIXTURE_MEDIA.archivedImageRef }],
  });
  mocks.collectAudioFiles.mockResolvedValue([]);
  mocks.collectMediaFiles.mockResolvedValue([
    {
      zipPath: 'media/asset-1.png',
      posterZipPath: 'media/asset-1.poster.jpg',
      sourceRef: DEFAULT_FIXTURE_MEDIA.archivedImageRef,
      elementId: DEFAULT_FIXTURE_MEDIA.archivedImageRef,
      record: {
        type: 'image',
        blob: new Blob([PNG_BYTES], { type: 'image/png' }),
        mimeType: 'image/png',
        size: PNG_BYTES.length,
        prompt: '',
      },
    },
  ]);
  mocks.collectVideoPosters.mockResolvedValue([]);
  mocks.collectLegacyAudioForExport.mockResolvedValue({
    audioUrlToPath: new Map(),
    blobs: [],
    fullyRescuedAudioIds: new Set(),
  });
  return stage;
}

async function exportFixture(
  options: Partial<StandaloneHtmlExportOptions> = {},
  scenes = standaloneFixtureScenes(STAGE_ID),
) {
  const stage = setupSnapshot(scenes);
  return buildStandaloneHtmlExport(stage, scenes, {
    strings,
    lang: 'en-US',
    fetchAsset,
    fetchImage,
    ...options,
  });
}

function embeddedJson<T>(html: string, id: string): T {
  const match = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(
    html,
  );
  if (!match) throw new Error(`no #${id}`);
  return JSON.parse(match[1]) as T;
}

function withSlideElements(scene: Scene, edit: (elements: PPTElement[]) => PPTElement[]): Scene {
  if (scene.content.type !== 'slide') return scene;
  const canvas = scene.content.canvas;
  return {
    ...scene,
    content: { ...scene.content, canvas: { ...canvas, elements: edit(canvas.elements) } },
  } as Scene;
}

function slideOf(manifest: ClassroomManifest) {
  const scene = manifest.scenes.find((s) => s.type === 'slide')!;
  if (scene.content.type !== 'slide') throw new Error('expected slide');
  return scene.content.canvas;
}

function imageSources(manifest: ClassroomManifest): string[] {
  return manifest.scenes.flatMap((scene) =>
    scene.content.type === 'slide'
      ? scene.content.canvas.elements.flatMap((element) =>
          element.type === 'image' ? [element.src] : [],
        )
      : [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('standalone HTML export', () => {
  it('embeds the manifest so markup inside content cannot break out of its script', async () => {
    const { html } = await exportFixture();

    // Only the real element boundaries close a script: 2 JSON blocks, the
    // charts runtime and the player.
    expect(html.match(/<\/script>/g)).toHaveLength(4);
    expect(html.match(/<!--/g)).toBeNull();

    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(manifest.stage.name).toBe('Photosynthesis: <Light> & "Life"');
    const quiz = manifest.scenes.find((scene) => scene.type === 'quiz')!;
    expect(quiz.content.type === 'quiz' && quiz.content.questions[1].question).toBe(
      'Which are inputs of photosynthesis? </script><!-- not markup -->',
    );
    expect(html).toContain('<title>Photosynthesis: &lt;Light&gt; &amp; &quot;Life&quot;</title>');
  });

  it('sets a restrictive CSP before any script or style', async () => {
    const { html } = await exportFixture();
    const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(cspIndex).toBeGreaterThan(-1);
    expect(cspIndex).toBeLessThan(html.indexOf('<style'));
    expect(cspIndex).toBeLessThan(html.indexOf('<script'));
    expect(html).toContain(`content="${STANDALONE_HTML_CSP}"`);
    expect(STANDALONE_HTML_CSP).toContain("default-src 'none'");
    expect(STANDALONE_HTML_CSP).toContain("connect-src 'none'");
    expect(STANDALONE_HTML_CSP).not.toMatch(/https?:/);
  });

  it('includes every scene in play order', async () => {
    const { html } = await exportFixture();
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(manifest.scenes.map((scene) => scene.type)).toEqual([
      'slide',
      'interactive',
      'quiz',
      'pbl',
    ]);
  });

  it('embeds slide images as data URIs and leaves no external image URL', async () => {
    const { html, unresolvedMedia } = await exportFixture();
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const sources = imageSources(manifest);
    expect(sources).toHaveLength(2);
    for (const src of sources) expect(src).toBe(`data:image/png;base64,${FIXTURE_PNG_BASE64}`);
    expect(html).not.toContain(DEFAULT_FIXTURE_MEDIA.remoteImageUrl);
    expect(html).not.toContain(DEFAULT_FIXTURE_MEDIA.archivedImageRef);
    expect(unresolvedMedia).toEqual([]);
    // The media index only describes archive payloads, which the file does not carry.
    expect(manifest.mediaIndex).toEqual({});
  });

  it('drops and reports images whose bytes resolve nowhere', async () => {
    const { html, unresolvedMedia } = await exportFixture({ fetchImage: async () => null });
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(unresolvedMedia).toEqual([DEFAULT_FIXTURE_MEDIA.remoteImageUrl]);
    expect(imageSources(manifest)).toEqual([`data:image/png;base64,${FIXTURE_PNG_BASE64}`, '']);
    expect(html).not.toContain(DEFAULT_FIXTURE_MEDIA.remoteImageUrl);
  });

  it('patches interactive HTML for the sandboxed iframe', async () => {
    const { html } = await exportFixture();
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const interactive = manifest.scenes.find((scene) => scene.type === 'interactive')!;
    expect(interactive.content.type).toBe('interactive');
    const content = interactive.content as { html?: string };
    expect(content.html).toContain('data-iframe-patch');
    expect(content.html).toContain('Light intensity lab');
  });

  it('uses the same sandbox flags as the classroom iframe host', () => {
    const host = readFileSync(
      path.join(process.cwd(), 'components/scene-renderers/InteractiveIframeHost.tsx'),
      'utf8',
    );
    expect(host).toContain(`sandbox="${STANDALONE_INTERACTIVE_SANDBOX}"`);
    expect(STANDALONE_INTERACTIVE_SANDBOX).not.toContain('allow-same-origin');
  });

  it('links PBL scenes to the online classroom only when a URL is given', async () => {
    const withUrl = await exportFixture({ classroomUrl: 'https://maic.example/classroom/abc' });
    expect(
      embeddedJson<StandalonePlayerConfig>(withUrl.html, STANDALONE_CONFIG_ELEMENT_ID).classroomUrl,
    ).toBe('https://maic.example/classroom/abc');

    const without = await exportFixture();
    const config = embeddedJson<StandalonePlayerConfig>(without.html, STANDALONE_CONFIG_ELEMENT_ID);
    expect(config).not.toHaveProperty('classroomUrl');
    expect(config.strings.pblContinueOnline).toBe('[pblContinueOnline]');
  });

  it('ships the charts runtime only when a slide has a chart', async () => {
    const full = await exportFixture();
    expect(full.html).toContain(CHARTS_SCRIPT);

    const slideOnly = standaloneFixtureScenes(STAGE_ID)
      .filter((scene) => scene.type === 'slide')
      .map((scene) =>
        withSlideElements(scene, (elements) => elements.filter((e) => e.type !== 'chart')),
      );
    fetchAsset.mockClear();
    const lean = await exportFixture({}, slideOnly);
    expect(lean.html).not.toContain(CHARTS_SCRIPT);
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it('ships the math fonts only when quiz text or slides contain math', async () => {
    // The fixture quiz is plain prose.
    expect((await exportFixture()).html).not.toContain(MATH_FONTS);

    const withMath = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      scene.content.type === 'quiz'
        ? ({
            ...scene,
            content: {
              ...scene.content,
              questions: [
                ...scene.content.questions,
                {
                  id: 'q-math',
                  type: 'single',
                  question: 'Solve $x^2 = 4$ for positive $x$.',
                  options: [
                    { value: 'A', label: '2' },
                    { value: 'B', label: '4' },
                  ],
                  answer: ['A'],
                },
              ],
            },
          } as Scene)
        : scene,
    );
    expect((await exportFixture({}, withMath)).html).toContain(MATH_FONTS);
  });

  it('names the file after the course', async () => {
    const { fileName } = await exportFixture();
    expect(fileName).toBe('Photosynthesis_ _Light_ & _Life_.html');
  });
});

const INJECTED_TEXT = `<p><img src="x" onerror="document.body.setAttribute('data-pwned','1')">Hello</p>`;
const INJECTED_IFRAME = `<p><iframe srcdoc="<script>parent.document.body.setAttribute('data-pwned','1')</script>"></iframe>Shape</p>`;
const INJECTED_META = `<meta http-equiv="refresh" content="0;url=https://evil.example/"><p>Cell</p>`;

describe('standalone HTML export content safety', () => {
  function injectedScenes(): Scene[] {
    return standaloneFixtureScenes(STAGE_ID).map((scene) =>
      withSlideElements(
        scene,
        (elements) =>
          [
            ...elements,
            {
              type: 'text',
              id: 'evil-text',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
              content: INJECTED_TEXT,
              defaultFontName: 'Arial',
              defaultColor: '#000',
            },
            {
              type: 'shape',
              id: 'evil-shape',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
              viewBox: [200, 200],
              path: 'M 0 0 L 200 0 L 200 200 Z',
              fixedRatio: false,
              fill: '#fff',
              text: {
                content: INJECTED_IFRAME,
                defaultFontName: 'Arial',
                defaultColor: '#000',
                align: 'middle',
              },
            },
            {
              type: 'table',
              id: 'evil-table',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
              outline: { width: 1, style: 'solid', color: '#000' },
              colWidths: [1],
              cellMinHeight: 20,
              data: [[{ id: 'c1', colspan: 1, rowspan: 1, text: INJECTED_META }]],
            },
            {
              type: 'latex',
              id: 'evil-latex',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
              latex: 'x',
              html: '<span class="katex">x</span><img src="x" onerror="alert(1)">',
              path: '',
              color: '#000',
              strokeWidth: 1,
              viewBox: [0, 0],
              fixedRatio: true,
            },
          ] as PPTElement[],
      ),
    );
  }

  it('sanitizes slide rich text before it reaches the player document', async () => {
    const { html } = await exportFixture({}, injectedScenes());
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const slideJson = JSON.stringify(slideOf(manifest));
    for (const marker of [
      'onerror',
      'data-pwned',
      '<iframe',
      'srcdoc',
      '<meta',
      'http-equiv',
      '<img',
    ]) {
      expect(slideJson).not.toContain(marker);
    }
    const byId = new Map(slideOf(manifest).elements.map((e) => [e.id, e]));
    expect(byId.get('evil-text')).toMatchObject({ content: '<p>Hello</p>' });
    expect(JSON.stringify(byId.get('evil-shape'))).toContain('Shape');
    expect(JSON.stringify(byId.get('evil-table'))).toContain('Cell');
    expect(byId.get('evil-latex')).toMatchObject({ html: '<span class="katex">x</span>' });
  });

  it('leaves no external address in rich text, styles or chart point images', async () => {
    const remotePoint = 'https://images.example.com/bar-fill.png';
    const deadPoint = 'https://images.example.com/missing.png';
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      withSlideElements(
        scene,
        (elements) =>
          [
            ...elements.map((element) =>
              element.type === 'chart'
                ? {
                    ...element,
                    importedStyle: {
                      series: [{ pointImages: { '0': remotePoint, '1': deadPoint } }],
                    },
                  }
                : element,
            ),
            {
              type: 'text',
              id: 'rich',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
              content:
                '<p style="background-image: url(https://images.example.com/bg.png); color: red">Hi <img src="https://images.example.com/inline.png"></p>',
              defaultFontName: 'Arial',
              defaultColor: '#000',
            },
          ] as PPTElement[],
      ),
    );
    const fetchImageWithPoint = vi.fn(async (url: string) =>
      url === deadPoint ? null : new Blob([PNG_BYTES], { type: 'image/png' }),
    );
    const { html, unresolvedMedia } = await exportFixture(
      { fetchImage: fetchImageWithPoint },
      scenes,
    );
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\/images\.example\.com/);
    const chart = slideOf(manifest).elements.find((e) => e.type === 'chart');
    expect(chart).toMatchObject({
      importedStyle: {
        series: [{ pointImages: { '0': `data:image/png;base64,${FIXTURE_PNG_BASE64}` } }],
      },
    });
    expect(unresolvedMedia).toEqual([deadPoint]);
    const rich = slideOf(manifest).elements.find((e) => e.id === 'rich');
    expect(rich).toMatchObject({ content: '<p style="color:red">Hi </p>' });
  });

  it('fetches a reference once even when several slots name it', async () => {
    const shared = DEFAULT_FIXTURE_MEDIA.remoteImageUrl;
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      scene.content.type === 'slide'
        ? ({
            ...scene,
            content: {
              ...scene.content,
              canvas: {
                ...scene.content.canvas,
                background: { type: 'image', image: { src: shared, size: 'cover' } },
              },
            },
          } as Scene)
        : scene,
    );
    await exportFixture({}, scenes);
    expect(fetchImage.mock.calls.filter(([url]) => url === shared)).toHaveLength(1);
  });

  it('leaves out data the player does not use', async () => {
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      scene.type === 'slide'
        ? ({
            ...scene,
            multiAgent: {
              enabled: true,
              agentIds: ['agent-1'],
              directorPrompt: 'Secret director prompt',
            },
          } as Scene)
        : scene,
    );
    const stage = setupSnapshot(scenes);
    Object.assign(stage, {
      generatedAgentConfigs: [
        {
          id: 'agent-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Secret persona',
          avatar: '',
          color: '#000',
          priority: 1,
        },
      ],
      videoManifest: { gen_vid_1: { prompt: 'Secret video prompt' } },
    });
    const { html } = await buildStandaloneHtmlExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
    });
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(manifest.agents).toEqual([]);
    expect(manifest.stage).not.toHaveProperty('videoManifest');
    for (const scene of manifest.scenes) {
      expect(scene).not.toHaveProperty('actions');
      expect(scene).not.toHaveProperty('multiAgent');
      expect(scene).not.toHaveProperty('whiteboards');
    }
    for (const secret of ['Secret', 'Let us look at photosynthesis', 'threads', 'submissions']) {
      expect(html).not.toContain(secret);
    }
  });

  it('resolves legacy PBL projects the way the classroom does and drops the legacy payload', async () => {
    const scenes = [{ ...legacyPBLSceneFixture, stageId: STAGE_ID }] as Scene[];
    const { html } = await exportFixture({}, scenes);
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const content = manifest.scenes[0].content as {
      projectV2?: { title: string; milestones: unknown[] };
      projectConfig?: unknown;
    };
    expect(content.projectConfig).toBeUndefined();
    expect(content.projectV2?.title).toBe('Community Garden Data Project');
    expect(content.projectV2?.milestones.length).toBeGreaterThan(0);
    expect(html).not.toContain('system_prompt');
  });

  it('skips narration and video bytes but keeps captured video posters', async () => {
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      withSlideElements(
        scene,
        (elements) =>
          [
            ...elements,
            {
              type: 'video',
              id: 'clip',
              left: 0,
              top: 0,
              width: 160,
              height: 90,
              rotate: 0,
              src: 'gen_vid_1',
              mediaRef: 'gen_vid_1',
              poster: 'gen_vid_1_poster',
              autoplay: false,
            },
          ] as PPTElement[],
      ),
    );
    const stage = setupSnapshot(scenes);
    mocks.buildAssetManifest.mockResolvedValue({
      entries: [
        { kind: 'audio', ref: 'aud-1' },
        { kind: 'image', ref: DEFAULT_FIXTURE_MEDIA.archivedImageRef },
        { kind: 'video', ref: 'gen_vid_1' },
        { kind: 'poster', ref: 'gen_vid_1_poster' },
      ],
    });
    mocks.collectVideoPosters.mockResolvedValue([
      { sourceRef: 'gen_vid_1', poster: new Blob([PNG_BYTES], { type: 'image/png' }) },
    ]);
    const { html, unresolvedMedia } = await buildStandaloneHtmlExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
    });

    expect(mocks.collectAudioFiles).not.toHaveBeenCalled();
    expect(mocks.collectLegacyAudioForExport).not.toHaveBeenCalled();
    const mediaKinds = mocks.collectMediaFiles.mock.calls[0][1].map(
      (e: { kind: string }) => e.kind,
    );
    expect(mediaKinds).not.toContain('video');
    expect(mocks.collectVideoPosters.mock.calls[0][1]).toEqual([
      { kind: 'video', ref: 'gen_vid_1' },
    ]);

    const clip = slideOf(
      embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID),
    ).elements.find((e) => e.id === 'clip');
    expect(clip).toMatchObject({ src: '', poster: `data:image/png;base64,${FIXTURE_PNG_BASE64}` });
    // The element's own poster ref resolved nowhere, but the captured frame covered it.
    expect(unresolvedMedia).toEqual([]);
  });
});

describe('prepareStandaloneManifest', () => {
  it('keeps only poster frames for video and drops audio sources', () => {
    const manifest = {
      formatVersion: 1,
      exportedAt: '',
      appVersion: '',
      stage: { name: 'x', createdAt: 0, updatedAt: 0 },
      agents: [],
      mediaIndex: {},
      scenes: [
        {
          type: 'slide',
          title: 'Video',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 's',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: '' },
              background: {
                type: 'image',
                image: { src: 'https://cdn.example/bg.png', size: 'cover' },
              },
              elements: [
                {
                  type: 'video',
                  id: 'v',
                  left: 0,
                  top: 0,
                  width: 10,
                  height: 10,
                  rotate: 0,
                  src: 'https://cdn.example/v.mp4',
                  mediaRef: 'gen_vid_1',
                  autoplay: false,
                },
                {
                  type: 'audio',
                  id: 'a',
                  left: 0,
                  top: 0,
                  width: 10,
                  height: 10,
                  rotate: 0,
                  src: 'https://cdn.example/a.mp3',
                  fixedRatio: true,
                  color: '#000',
                  loop: false,
                  autoplay: false,
                },
              ],
            },
          },
        },
      ],
    } as unknown as ClassroomManifest;
    const { manifest: prepared, unresolved } = prepareStandaloneManifest(manifest, {
      dataUris: new Map(),
      videoPosters: new Map([['gen_vid_1', 'data:image/jpeg;base64,AAAA']]),
    });
    const scene = prepared.scenes[0];
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    const [video, audio] = scene.content.canvas.elements;
    expect(video).toMatchObject({ type: 'video', src: '', poster: 'data:image/jpeg;base64,AAAA' });
    expect(video).not.toHaveProperty('mediaRef');
    expect(audio).toMatchObject({ type: 'audio', src: '' });
    expect(scene.content.canvas.background).toMatchObject({ type: 'solid' });
    expect(unresolved).toEqual(['https://cdn.example/bg.png']);
    expect(JSON.stringify(prepared)).not.toContain('cdn.example');
  });
});

describe('assembleStandaloneHtml', () => {
  const base = {
    manifest: {
      formatVersion: 1,
      exportedAt: '',
      appVersion: '',
      stage: { name: 'x', createdAt: 0, updatedAt: 0 },
      agents: [],
      scenes: [],
      mediaIndex: {},
    } as ClassroomManifest,
    config: { strings },
    playerStyle: '',
    lang: 'en-US',
  };

  it('refuses a player payload that would end its element', () => {
    expect(() => assembleStandaloneHtml({ ...base, playerScript: 'var s = "</script>";' })).toThrow(
      /player script/,
    );
    expect(() => assembleStandaloneHtml({ ...base, playerScript: 'var s = "<!--";' })).toThrow();
    expect(() =>
      assembleStandaloneHtml({ ...base, playerScript: '', playerStyle: 'a{}</style>' }),
    ).toThrow(/style sheet/);
  });

  it('serializes JSON without raw angle brackets, ampersands or line separators', () => {
    const value = { text: '</script><!--<script>&\u2028\u2029' };
    const serialized = serializeJsonForHtmlScript(value);
    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(serialized)).toEqual(value);
  });
});

describe('resolvePublicClassroomUrl', () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the classroom address only for a published classroom', async () => {
    await expect(
      resolvePublicClassroomUrl('stage 1', 'https://maic.example', respond({ isPublic: true })),
    ).resolves.toBe('https://maic.example/classroom/stage%201');
    await expect(
      resolvePublicClassroomUrl('stage-1', 'https://maic.example', respond({ isPublic: false })),
    ).resolves.toBeUndefined();
    await expect(
      resolvePublicClassroomUrl('stage-1', 'https://maic.example', respond({}, 404)),
    ).resolves.toBeUndefined();
  });
});
