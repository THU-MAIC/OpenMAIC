// @vitest-environment jsdom
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
  proxiedFetch: vi.fn(async (_url: string): Promise<Response> => {
    throw new Error('offline');
  }),
}));

vi.mock('@/lib/export/proxied-fetch', () => ({
  createProxiedFetch: () => (input: RequestInfo | URL) =>
    mocks.proxiedFetch(typeof input === 'string' ? input : String(input)),
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

import JSZip from 'jszip';
import {
  buildStandaloneHtmlExport,
  buildStandaloneZip,
  classroomUrlFor,
  collectStandaloneMediaBytes,
  decodeImageDataUri,
  encodeStandaloneImages,
  linkStandaloneImages,
  estimateStandaloneHtmlBytes,
  linkedMediaSrc,
  STANDALONE_ZIP_README_EN,
  standaloneZipReadme,
  type StandaloneHtmlExportOptions,
} from '@/lib/export/standalone-html/build-standalone-html';
import {
  STANDALONE_HTML_CSP,
  STANDALONE_HTML_LINKED_FILES_CSP,
  assembleStandaloneHtml,
  serializeJsonForHtmlScript,
} from '@/lib/export/standalone-html/assemble';
import {
  STANDALONE_CONFIG_ELEMENT_ID,
  STANDALONE_INTERACTIVE_SANDBOX,
  STANDALONE_MANIFEST_ELEMENT_ID,
  STANDALONE_MEDIA_TABLE_ELEMENT_ID,
  type StandaloneMediaTable,
  STANDALONE_PLAYER_ASSETS,
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerConfig,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';
import {
  prepareStandaloneActions,
  prepareStandaloneManifest,
  stripMediaPayloads,
} from '@/lib/export/standalone-html/prepare-manifest';
import {
  STANDALONE_HTML_MAX_BYTES,
  StandaloneHtmlTooLargeError,
} from '@/lib/export/standalone-html/limits';
import type { ClassroomManifest, ManifestAction } from '@/lib/export/classroom-zip-types';
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

/** The export, with the document read back as text. */
async function buildExport(...args: Parameters<typeof buildStandaloneHtmlExport>) {
  const result = await buildStandaloneHtmlExport(...args);
  return { ...result, html: await result.blob.text() };
}

async function exportFixture(
  options: Partial<StandaloneHtmlExportOptions> = {},
  scenes = standaloneFixtureScenes(STAGE_ID),
) {
  const stage = setupSnapshot(scenes);
  return buildExport(stage, scenes, {
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

/**
 * A classroom with stored and legacy narration and a generated video, the
 * snapshot collectors mocked to return their bytes (one narration is lost).
 */
function setupNarratedClassroom() {
  const AUDIO_BYTES = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);
  const LEGACY_BYTES = Uint8Array.from([0xff, 0xfb, 9, 8, 7]);
  const VIDEO_BYTES = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2]);
  const legacyUrl = 'https://cdn.example/narration/legacy.mp3';
  const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
    scene.type === 'slide'
      ? ({
          ...withSlideElements(
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
                  autoplay: false,
                },
              ] as PPTElement[],
          ),
          actions: [
            { id: 'sp', type: 'spotlight', elementId: 'leaf', dimOpacity: 0.6 },
            { id: 's1', type: 'speech', text: 'Stored narration.', audioId: 'aud-1' },
            { id: 'v1', type: 'play_video', elementId: 'clip' },
            { id: 's2', type: 'speech', text: 'Legacy narration.', audioUrl: legacyUrl },
            { id: 's3', type: 'speech', text: 'No audio at all.' },
            { id: 's4', type: 'speech', text: 'Lost audio.', audioId: 'aud-missing' },
          ],
        } as Scene)
      : scene,
  );
  const stage = setupSnapshot(scenes);
  mocks.buildAssetManifest.mockResolvedValue({
    entries: [
      { kind: 'audio', ref: 'aud-1' },
      { kind: 'audio', ref: 'aud-missing' },
      { kind: 'image', ref: DEFAULT_FIXTURE_MEDIA.archivedImageRef },
      { kind: 'video', ref: 'gen_vid_1' },
    ],
  });
  mocks.collectAudioFiles.mockResolvedValue([
    {
      zipPath: 'audio/audio-1.mp3',
      sourceRef: 'aud-1',
      mimeType: 'audio/mpeg',
      record: {
        id: 'aud-1',
        blob: new Blob([AUDIO_BYTES], { type: 'audio/mpeg' }),
        format: 'mp3',
      },
    },
  ]);
  mocks.collectLegacyAudioForExport.mockResolvedValue({
    audioUrlToPath: new Map([[legacyUrl, 'audio/legacy-1.mp3']]),
    blobs: [
      {
        zipPath: 'audio/legacy-1.mp3',
        blob: new Blob([LEGACY_BYTES], { type: 'audio/mpeg' }),
        format: 'mp3',
        mimeType: 'audio/mpeg',
        sourceRef: legacyUrl,
      },
    ],
    fullyRescuedAudioIds: new Set(),
  });
  mocks.collectMediaFiles.mockImplementation(async (_stageId, entries) =>
    (entries as Array<{ kind: string; ref: string }>).flatMap((entry, index) => {
      if (entry.kind === 'image') {
        return [
          {
            zipPath: `media/asset-${index + 1}.png`,
            posterZipPath: `media/asset-${index + 1}.poster.jpg`,
            sourceRef: entry.ref,
            elementId: entry.ref,
            record: {
              type: 'image',
              blob: new Blob([PNG_BYTES], { type: 'image/png' }),
              mimeType: 'image/png',
              size: PNG_BYTES.length,
              prompt: '',
            },
          },
        ];
      }
      if (entry.kind === 'video') {
        return [
          {
            zipPath: `media/asset-${index + 1}.mp4`,
            posterZipPath: `media/asset-${index + 1}.poster.jpg`,
            sourceRef: entry.ref,
            elementId: entry.ref,
            record: {
              type: 'video',
              blob: new Blob([VIDEO_BYTES], { type: 'video/mp4' }),
              mimeType: 'video/mp4',
              size: VIDEO_BYTES.length,
              prompt: 'Secret video prompt',
              poster: new Blob([PNG_BYTES], { type: 'image/png' }),
            },
          },
        ];
      }
      return [];
    }),
  );
  return { stage, scenes, AUDIO_BYTES, LEGACY_BYTES, VIDEO_BYTES };
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
    // Resources the sanitizer drops are reported, not lost silently.
    expect(unresolvedMedia.sort()).toEqual(
      [
        'https://images.example.com/bg.png',
        'https://images.example.com/inline.png',
        deadPoint,
      ].sort(),
    );
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
            whiteboards: [{ id: 'wb', elements: [], secret: 'Secret whiteboard' }],
            actions: [
              ...(scene.actions ?? []),
              { id: 'wb-1', type: 'wb_draw_text', content: 'Secret board text', x: 0, y: 0 },
              {
                id: 'disc-1',
                type: 'discussion',
                topic: 'Why are leaves green?',
                prompt: 'Secret discussion prompt',
                agentId: 'agent-1',
              },
            ],
          } as unknown as Scene)
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
    const { html } = await buildExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
    });
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(manifest.agents).toEqual([]);
    expect(manifest.stage).not.toHaveProperty('videoManifest');
    for (const scene of manifest.scenes) {
      expect(scene).not.toHaveProperty('multiAgent');
      expect(scene).not.toHaveProperty('whiteboards');
    }
    // Playback actions stay, reduced to what the player replays: the
    // whiteboard action and the discussion's agent binding and prompt go.
    expect(manifest.scenes.find((scene) => scene.type === 'slide')?.actions).toEqual([
      { id: 'speech-1', type: 'speech', text: 'Let us look at photosynthesis.' },
      { id: 'disc-1', type: 'discussion', topic: 'Why are leaves green?' },
    ]);
    for (const secret of ['Secret', 'threads', 'submissions', 'agentIndex', 'agentId']) {
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
    const { html, unresolvedMedia } = await buildExport(stage, scenes, {
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
    expect(clip).not.toHaveProperty('mediaRef');
    // The element's own poster ref resolved nowhere, but the captured frame covered it.
    expect(unresolvedMedia).toEqual([]);
    expect(html).not.toContain(STANDALONE_MEDIA_TABLE_ELEMENT_ID);
  });

  it('embeds narration (stored and legacy) and video bytes when narration is included', async () => {
    const { stage, scenes, AUDIO_BYTES, LEGACY_BYTES, VIDEO_BYTES } = setupNarratedClassroom();
    const result = await buildExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
      includeNarration: true,
    });
    const { html } = result;

    expect(mocks.collectAudioFiles).toHaveBeenCalled();
    expect(mocks.collectLegacyAudioForExport).toHaveBeenCalled();
    expect(result.missingAudioCount).toBe(1);
    expect(result.byteSize).toBe(Buffer.byteLength(html, 'utf8'));
    expect(result.blob.type).toBe('text/html;charset=utf-8');

    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const slideScene = manifest.scenes.find((scene) => scene.type === 'slide')!;
    expect(slideScene.actions).toEqual([
      { id: 'sp', type: 'spotlight', elementId: 'leaf', dimOpacity: 0.6 },
      { id: 's1', type: 'speech', text: 'Stored narration.', audioRef: 'audio/audio-1.mp3' },
      { id: 'v1', type: 'play_video', elementId: 'clip' },
      { id: 's2', type: 'speech', text: 'Legacy narration.', audioRef: 'audio/legacy-1.mp3' },
      { id: 's3', type: 'speech', text: 'No audio at all.' },
      { id: 's4', type: 'speech', text: 'Lost audio.' },
    ]);
    const clip = slideOf(manifest).elements.find((e) => e.id === 'clip');
    expect(clip).toMatchObject({
      src: '',
      mediaRef: 'media/asset-2.mp4',
      poster: `data:image/png;base64,${FIXTURE_PNG_BASE64}`,
    });

    const table = embeddedJson<StandaloneMediaTable>(html, STANDALONE_MEDIA_TABLE_ELEMENT_ID);
    expect(Object.keys(table).sort()).toEqual([
      'audio/audio-1.mp3',
      'audio/legacy-1.mp3',
      'media/asset-2.mp4',
    ]);
    const bytesOf = (key: string) => {
      const entry = table[key];
      const block = new RegExp(
        `<script type="application/octet-stream" id="${entry.embedded}">([^<]*)</script>`,
      ).exec(html);
      if (!block) throw new Error(`no block for ${key}`);
      return Uint8Array.from(Buffer.from(block[1], 'base64'));
    };
    expect(table['audio/audio-1.mp3'].mimeType).toBe('audio/mpeg');
    expect(table['media/asset-2.mp4'].mimeType).toBe('video/mp4');
    expect(bytesOf('audio/audio-1.mp3')).toEqual(AUDIO_BYTES);
    expect(bytesOf('audio/legacy-1.mp3')).toEqual(LEGACY_BYTES);
    expect(bytesOf('media/asset-2.mp4')).toEqual(VIDEO_BYTES);

    // Still nothing to fetch: no source URL, prompt or archive index survives.
    expect(html).not.toContain('cdn.example');
    expect(html).not.toContain('Secret');
    expect(html).not.toContain('mediaIndex":{"');
    expect(html).toContain(`content="${STANDALONE_HTML_CSP}"`);
  });
});

describe('standalone HTML export media policy', () => {
  const VIDEO_BYTES = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 7, 7]);
  const interactiveWithMedia = `<!doctype html><html><body>
<img src="https://assets.example/diagram.png">
<video src="https://assets.example/clip.mp4" poster="https://assets.example/poster.png"></video>
<video><source src="https://assets.example/other.webm" type="video/webm"></video>
<audio src="data:audio/mpeg;base64,SUQzBAAAAAAA"></audio>
<picture><source srcset="https://assets.example/a.webp"><img src="https://assets.example/b.png"></picture>
</body></html>`;

  function withInteractiveMedia(): Scene[] {
    return standaloneFixtureScenes(STAGE_ID).map((scene) =>
      scene.type === 'interactive'
        ? ({ ...scene, content: { ...scene.content, html: interactiveWithMedia } } as Scene)
        : scene,
    );
  }

  function serveAssets() {
    mocks.proxiedFetch.mockImplementation(async (url: string) => {
      const type = url.endsWith('.mp4')
        ? 'video/mp4'
        : url.endsWith('.webm')
          ? 'video/webm'
          : url.endsWith('.webp')
            ? 'image/webp'
            : 'image/png';
      const body = type.startsWith('video/') ? VIDEO_BYTES : PNG_BYTES;
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    });
  }

  function interactiveHtml(html: string): string {
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const scene = manifest.scenes.find((entry) => entry.type === 'interactive')!;
    if (scene.content.type !== 'interactive') throw new Error('expected interactive');
    return scene.content.html ?? '';
  }

  it('without narration ships no audio or video payload, interactive pages included', async () => {
    serveAssets();
    const { html } = await exportFixture({ includeNarration: false }, withInteractiveMedia());
    const fetched = mocks.proxiedFetch.mock.calls.map(([url]) => url);
    expect(fetched).not.toContain('https://assets.example/clip.mp4');
    expect(fetched).not.toContain('https://assets.example/other.webm');
    const page = interactiveHtml(html);
    expect(page).not.toMatch(/data:(audio|video)\//);
    expect(page).not.toContain('assets.example/clip.mp4');
    expect(page).not.toContain('assets.example/other.webm');
    // The page keeps its other assets, inlined: images and the video poster.
    expect(page).toContain('<video');
    expect(page).not.toContain('https://assets.example/diagram.png');
    expect(page).not.toContain('https://assets.example/poster.png');
    expect(page).toMatch(/srcset="data:image\/webp/);
    expect(html).not.toMatch(/data:(audio|video)\//);
  });

  it('with narration interactive pages keep their clips, inlined', async () => {
    serveAssets();
    const { html } = await exportFixture({ includeNarration: true }, withInteractiveMedia());
    const page = interactiveHtml(html);
    expect(page).toContain('data:video/mp4;base64,');
    expect(page).toContain('data:video/webm;base64,');
    expect(page).toContain('data:audio/mpeg;base64,SUQzBAAAAAAA');
  });

  it('stripMediaPayloads keeps picture sources and media elements without payloads', () => {
    const html =
      '<video src="blob:x"></video><audio src="clip.mp3"></audio>' +
      '<picture><source src="https://a.example/p.png"></picture>';
    expect(stripMediaPayloads(html)).toBe(
      '<video ></video><audio src="clip.mp3"></audio>' +
        '<picture><source src="https://a.example/p.png"></picture>',
    );
  });

  it('stripMediaPayloads strips data: sources whatever MIME they declare', () => {
    const html =
      '<audio src="data:application/octet-stream;base64,SUQzBAAA"></audio>' +
      '<video><source src="data:;base64,AAAA"></video><img src="data:image/png;base64,iVBO">';
    const stripped = stripMediaPayloads(html);
    expect(stripped).not.toContain('SUQzBAAA');
    expect(stripped).not.toContain('AAAA');
    expect(stripped).toContain('<img src="data:image/png;base64,iVBO">');
  });

  it('stripMediaPayloads recurses into nested srcdoc documents', () => {
    const inner = '<p>Inner &amp; more</p><video src="data:video/mp4;base64,AAAAGGZ0"></video>';
    const innermost = '<audio src="https://media.example/a.mp3"></audio>';
    const middle = `<iframe srcdoc="${innermost.replace(/"/g, '&quot;')}"></iframe>${inner}`;
    const html = `<iframe srcdoc="${middle.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
    const stripped = stripMediaPayloads(html);
    expect(stripped).not.toContain('AAAAGGZ0');
    expect(stripped).not.toContain('media.example');
    // The nested documents survive (re-escaped) apart from their media.
    const outer = new DOMParser().parseFromString(stripped, 'text/html');
    const middleDoc = outer.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(middleDoc).toContain('<p>Inner &amp; more</p>');
    expect(middleDoc).toContain('<video');
  });

  it('stripMediaPayloads drops srcdoc documents nested too deep to inspect', () => {
    let html = '<video src="data:video/mp4;base64,DEEP"></video>';
    for (let level = 0; level < 6; level++) {
      html = `<iframe srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
    }
    expect(stripMediaPayloads(html)).not.toContain('DEEP');
  });

  function withDirectVideo(src: string): Scene[] {
    return standaloneFixtureScenes(STAGE_ID).map((scene) =>
      withSlideElements(
        scene,
        (elements) =>
          [
            ...elements,
            {
              type: 'video',
              id: 'direct',
              left: 0,
              top: 0,
              width: 160,
              height: 90,
              rotate: 0,
              src,
              autoplay: false,
            },
          ] as PPTElement[],
      ),
    );
  }

  it('fetches and embeds a direct slide video URL no stored asset backs', async () => {
    const url = 'https://videos.example/lesson/clip.mp4';
    const fetchVideo = vi.fn(async () => new Blob([VIDEO_BYTES], { type: 'video/mp4' }));
    const { html, unresolvedMedia } = await exportFixture(
      { includeNarration: true, fetchVideo },
      withDirectVideo(url),
    );
    expect(fetchVideo).toHaveBeenCalledWith(url);
    expect(unresolvedMedia).toEqual([]);
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    expect(slideOf(manifest).elements.find((e) => e.id === 'direct')).toMatchObject({
      src: '',
      mediaRef: 'media/linked-1.mp4',
    });
    const table = embeddedJson<StandaloneMediaTable>(html, STANDALONE_MEDIA_TABLE_ELEMENT_ID);
    expect(table['media/linked-1.mp4']).toMatchObject({ mimeType: 'video/mp4' });
    expect(html).not.toContain('videos.example');
  });

  it('reports a slide video whose bytes could not be fetched', async () => {
    const url = 'https://videos.example/lesson/gone.mp4';
    const { unresolvedMedia } = await exportFixture(
      { includeNarration: true, fetchVideo: async () => null },
      withDirectVideo(url),
    );
    expect(unresolvedMedia).toContain(url);
  });

  it('does not fetch or report slide videos without narration (poster only)', async () => {
    const fetchVideo = vi.fn(async () => null);
    const { unresolvedMedia } = await exportFixture(
      { includeNarration: false, fetchVideo },
      withDirectVideo('https://videos.example/clip.mp4'),
    );
    expect(fetchVideo).not.toHaveBeenCalled();
    expect(unresolvedMedia).toEqual([]);
  });

  it('collects and counts only narration, not slide audio elements', async () => {
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      scene.type === 'slide'
        ? ({
            ...withSlideElements(
              scene,
              (elements) =>
                [
                  ...elements,
                  {
                    type: 'audio',
                    id: 'bgm',
                    left: 0,
                    top: 0,
                    width: 10,
                    height: 10,
                    rotate: 0,
                    src: 'aud-element',
                    fixedRatio: true,
                    color: '#000',
                    loop: false,
                    autoplay: false,
                  },
                ] as PPTElement[],
            ),
            actions: [{ id: 's', type: 'speech', text: 'Hi', audioId: 'aud-speech' }],
          } as Scene)
        : scene,
    );
    const stage = setupSnapshot(scenes);
    mocks.buildAssetManifest.mockResolvedValue({
      entries: [
        { kind: 'audio', ref: 'aud-element' },
        { kind: 'audio', ref: 'aud-speech' },
      ],
    });
    const result = await buildExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
      includeNarration: true,
    });
    expect(mocks.collectAudioFiles.mock.calls[0][0]).toEqual([
      { kind: 'audio', ref: 'aud-speech' },
    ]);
    // Only the narration is missing (the mock collects nothing).
    expect(result.missingAudioCount).toBe(1);
  });

  it('estimates the manifest as the escaped UTF-8 bytes the document carries', () => {
    const manifest = {
      formatVersion: 1,
      exportedAt: '',
      appVersion: '',
      stage: { name: '<中文>', createdAt: 0, updatedAt: 0 },
      agents: [],
      scenes: [],
      mediaIndex: {},
    } as ClassroomManifest;
    const escapedBytes = Buffer.byteLength(serializeJsonForHtmlScript(manifest), 'utf8');
    expect(escapedBytes).toBeGreaterThan(JSON.stringify(manifest).length);
    const payload = { blob: new Blob([new Uint8Array(3000)]) };
    expect(estimateStandaloneHtmlBytes(manifest, [payload])).toBe(
      4000 + escapedBytes + 1024 * 1024,
    );
  });

  it('refuses a file whose assembled size passes the ceiling though the estimate did not', async () => {
    // A player asset far larger than the estimate allows for: only the exact
    // check after assembly can catch it.
    const oversizedPlayer = 'x'.repeat(2 * 1024 * 1024);
    const attempt = exportFixture({
      maxBytes: 1.5 * 1024 * 1024,
      fetchAsset: async (assetPath: string) =>
        assetPath === STANDALONE_PLAYER_ASSETS.script ? oversizedPlayer : fetchAsset(assetPath),
    });
    await expect(attempt).rejects.toBeInstanceOf(StandaloneHtmlTooLargeError);
    await expect(attempt).rejects.toMatchObject({
      estimatedBytes: expect.any(Number),
    });
    // The same export within the ceiling succeeds.
    await expect(exportFixture({ maxBytes: 3 * 1024 * 1024 })).resolves.toBeTruthy();
  });

  it('refuses, before encoding any media, a file above the size ceiling', async () => {
    const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
      withSlideElements(
        scene,
        (elements) =>
          [
            ...elements,
            {
              type: 'video',
              id: 'huge',
              left: 0,
              top: 0,
              width: 160,
              height: 90,
              rotate: 0,
              src: 'gen_vid_huge',
              mediaRef: 'gen_vid_huge',
              autoplay: false,
            },
          ] as PPTElement[],
      ),
    );
    const stage = setupSnapshot(scenes);
    const huge = new Blob([VIDEO_BYTES], { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: STANDALONE_HTML_MAX_BYTES });
    const arrayBuffer = vi.spyOn(huge, 'arrayBuffer');
    mocks.buildAssetManifest.mockResolvedValue({
      entries: [{ kind: 'video', ref: 'gen_vid_huge' }],
    });
    mocks.collectMediaFiles.mockResolvedValue([
      {
        zipPath: 'media/asset-1.mp4',
        posterZipPath: 'media/asset-1.poster.jpg',
        sourceRef: 'gen_vid_huge',
        elementId: 'gen_vid_huge',
        record: { type: 'video', blob: huge, mimeType: 'video/mp4', size: huge.size, prompt: '' },
      },
    ]);
    const attempt = buildStandaloneHtmlExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
      includeNarration: true,
    });
    await expect(attempt).rejects.toBeInstanceOf(StandaloneHtmlTooLargeError);
    await expect(attempt).rejects.toMatchObject({
      estimatedBytes: expect.any(Number),
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
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

  it('names shipped video bytes by archive path and lists the playback media used', () => {
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
              elements: [
                {
                  type: 'video',
                  id: 'v',
                  left: 0,
                  top: 0,
                  width: 10,
                  height: 10,
                  rotate: 0,
                  src: 'gen_vid_1',
                  mediaRef: 'gen_vid_1',
                  autoplay: false,
                },
              ],
            },
          },
          actions: [
            { id: 's', type: 'speech', text: 'Look', audioRef: 'audio/audio-1.mp3' },
            { id: 'p', type: 'play_video', elementId: 'v' },
          ],
        },
      ],
    } as unknown as ClassroomManifest;
    const { manifest: prepared, playbackMedia } = prepareStandaloneManifest(manifest, {
      dataUris: new Map(),
      playback: {
        audio: new Set(['audio/audio-1.mp3']),
        videos: new Map([['gen_vid_1', 'media/asset-1.mp4']]),
      },
    });
    const scene = prepared.scenes[0];
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    expect(scene.content.canvas.elements[0]).toMatchObject({
      src: '',
      mediaRef: 'media/asset-1.mp4',
    });
    expect(scene.actions).toHaveLength(2);
    expect(playbackMedia).toEqual(['audio/audio-1.mp3', 'media/asset-1.mp4']);
  });
});

describe('prepareStandaloneActions', () => {
  it('keeps replayed actions in order, reduced to the fields the player reads', () => {
    const actions = [
      { id: 'a', type: 'spotlight', elementId: 'e1', dimOpacity: 0.4, title: 'x' },
      {
        id: 'b',
        type: 'speech',
        text: 'Hello',
        audioRef: 'audio/audio-1.mp3',
        voice: 'v',
        speed: 1.2,
        audioInvalidated: false,
      },
      { id: 'c', type: 'laser', elementId: 'e2', color: '#00f' },
      { id: 'd', type: 'wb_open' },
      { id: 'e', type: 'wb_draw_text', content: 'x', x: 0, y: 0 },
      { id: 'f', type: 'play_video', elementId: 'clip' },
      { id: 'g', type: 'widget_setState', state: { k: 1 }, content: 'Now' },
      { id: 'h', type: 'widget_highlight', target: '#x' },
      { id: 'i', type: 'discussion', topic: 'T', prompt: 'P', agentIndex: 0 },
      { id: 'j', type: 'teleport' },
    ] as unknown as ManifestAction[];
    const used: string[] = [];
    const prepared = prepareStandaloneActions(actions, new Set(['audio/audio-1.mp3']), {
      usePlaybackMedia: (path) => used.push(path),
    });
    expect(prepared).toEqual([
      { id: 'a', type: 'spotlight', elementId: 'e1', dimOpacity: 0.4 },
      { id: 'b', type: 'speech', text: 'Hello', audioRef: 'audio/audio-1.mp3' },
      { id: 'c', type: 'laser', elementId: 'e2', color: '#00f' },
      { id: 'f', type: 'play_video', elementId: 'clip' },
      { id: 'g', type: 'widget_setState', state: { k: 1 }, content: 'Now' },
      { id: 'h', type: 'widget_highlight', target: '#x' },
      { id: 'i', type: 'discussion', topic: 'T' },
    ]);
    expect(used).toEqual(['audio/audio-1.mp3']);
  });

  it('drops an audioRef whose bytes do not ship, keeping the text for the reading timer', () => {
    const actions = [
      { id: 'b', type: 'speech', text: 'Hello', audioRef: 'audio/audio-1.mp3' },
    ] as unknown as ManifestAction[];
    expect(prepareStandaloneActions(actions, undefined)).toEqual([
      { id: 'b', type: 'speech', text: 'Hello' },
    ]);
    expect(prepareStandaloneActions(actions, new Set(['audio/audio-2.mp3']))).toEqual([
      { id: 'b', type: 'speech', text: 'Hello' },
    ]);
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

  it('carries the same no-script fallback in the ZIP variant, under its own CSP', () => {
    const html = assembleStandaloneHtml({ ...base, playerScript: '', linkedFiles: true });
    expect(html).toContain('data-testid="script-fallback"');
    expect(html).toContain('<noscript><p class="openmaic-message">[scriptRequired]</p></noscript>');
    expect(html).toContain(`content="${STANDALONE_HTML_LINKED_FILES_CSP}"`);
    // The fallback's styles are inline, which that policy allows.
    expect(STANDALONE_HTML_LINKED_FILES_CSP).toContain("style-src 'unsafe-inline'");
  });

  it('carries a static no-script message that paints only once the player script is next', () => {
    const html = assembleStandaloneHtml({
      ...base,
      playerScript: 'window.__p = 1;',
      embeddedMedia: [{ key: 'audio/a.mp3', mimeType: 'audio/mpeg', base64: 'SUQz' }],
    });
    const message = html.indexOf('data-testid="script-fallback"');
    expect(message).toBeGreaterThan(-1);
    // Not in the (empty) root, and after the data blocks, right before the player:
    // nothing shows while a large file is still being parsed.
    expect(html).toContain('<div id="openmaic-player"></div>');
    expect(message).toBeGreaterThan(html.indexOf('openmaic-media-1'));
    expect(message).toBeLessThan(html.indexOf('<script>window.__p'));
    expect(html.slice(message, html.indexOf('<script>window.__p'))).not.toContain('SUQz');
    expect(html).toContain('[scriptRequired]');
    expect(html).toContain('data-failed-text="[startFailed]"');
    // Backstop: hidden for the first seconds even if reached before the script runs.
    expect(html).toMatch(/\.openmaic-fallback\{opacity:0;animation:[^}]*2s/);
    // The empty root keeps the viewport's height otherwise, pushing the message off screen.
    expect(html).toContain('#openmaic-player:empty{display:none}');
    // With scripts disabled the copy above is hidden and the <noscript> one shows.
    expect(html).toContain('<noscript><style>.openmaic-fallback{display:none}</style></noscript>');
    expect(html).toContain('<noscript><p class="openmaic-message">[scriptRequired]</p></noscript>');
    expect(html).toContain(`content="${STANDALONE_HTML_CSP}"`);
  });

  it('escapes the fallback message', () => {
    const html = assembleStandaloneHtml({
      ...base,
      playerScript: '',
      config: { strings: { ...strings, scriptRequired: '<b>"x"</b>' } },
    });
    expect(html).not.toContain('<b>"x"</b>');
    expect(html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('embeds media as non-executable base64 data blocks named by the media table', () => {
    const html = assembleStandaloneHtml({
      ...base,
      playerScript: '',
      embeddedMedia: [{ key: 'audio/audio-1.mp3', mimeType: 'audio/mpeg', base64: 'SUQzAQID' }],
    });
    expect(html).toContain(
      '<script type="application/octet-stream" id="openmaic-media-1">SUQzAQID</script>',
    );
    expect(embeddedJson<StandaloneMediaTable>(html, STANDALONE_MEDIA_TABLE_ELEMENT_ID)).toEqual({
      'audio/audio-1.mp3': { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' },
    });
    // The data blocks precede the player, so they are parsed when it runs.
    expect(html.indexOf('openmaic-media-1')).toBeLessThan(html.lastIndexOf('<script>'));
    expect(() =>
      assembleStandaloneHtml({
        ...base,
        playerScript: '',
        embeddedMedia: [{ key: 'k', mimeType: 'audio/mpeg', base64: '</script>' }],
      }),
    ).toThrow(/not base64/);
  });

  it('references linked media by src in a document with linked files', () => {
    const html = assembleStandaloneHtml({
      ...base,
      playerScript: '',
      linkedFiles: true,
      linkedMedia: [{ key: 'media/asset-1.mp4', mimeType: 'video/mp4', src: 'media/asset-1.mp4' }],
    });
    expect(embeddedJson<StandaloneMediaTable>(html, STANDALONE_MEDIA_TABLE_ELEMENT_ID)).toEqual({
      'media/asset-1.mp4': { mimeType: 'video/mp4', src: 'media/asset-1.mp4' },
    });
    expect(html).not.toContain('application/octet-stream');
    expect(html).toContain(`content="${STANDALONE_HTML_LINKED_FILES_CSP}"`);
    expect(html).not.toContain(`content="${STANDALONE_HTML_CSP}"`);
    // Without linked files, the single file's policy is used.
    expect(assembleStandaloneHtml({ ...base, playerScript: '' })).toContain(
      `content="${STANDALONE_HTML_CSP}"`,
    );
    // Linked media in a document whose policy would block it is refused.
    expect(() =>
      assembleStandaloneHtml({
        ...base,
        playerScript: '',
        linkedMedia: [{ key: 'k', mimeType: 'audio/mpeg', src: 'audio/k.mp3' }],
      }),
    ).toThrow(/linked files/);
  });

  it('pins both policies: only img-src and media-src differ, and nothing may be fetched', () => {
    expect(STANDALONE_HTML_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; " +
        'font-src data:; frame-src data: blob:; worker-src data: blob:; ' +
        "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(STANDALONE_HTML_LINKED_FILES_CSP).toBe(
      STANDALONE_HTML_CSP.replace('img-src data: blob:', "img-src 'self' data: blob:").replace(
        'media-src data: blob:',
        "media-src 'self' data: blob:",
      ),
    );
  });

  it('serializes JSON without raw angle brackets, ampersands or line separators', () => {
    const value = { text: '</script><!--<script>&\u2028\u2029' };
    const serialized = serializeJsonForHtmlScript(value);
    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(serialized)).toEqual(value);
  });
});

describe('classroomUrlFor', () => {
  it('addresses the classroom page on the exporting origin', () => {
    expect(classroomUrlFor('https://maic.example', 'stage-1')).toBe(
      'https://maic.example/classroom/stage-1',
    );
  });

  it('encodes the stage id and tolerates a trailing slash on the origin', () => {
    expect(classroomUrlFor('https://maic.example/', 'stage 1/#?')).toBe(
      'https://maic.example/classroom/stage%201%2F%23%3F',
    );
    expect(classroomUrlFor('https://maic.example//', 'a')).toBe('https://maic.example/classroom/a');
  });
});

describe('standalone HTML ZIP variant', () => {
  const ZIP_DATE = new Date(2026, 0, 2, 3, 4, 6);

  async function narratedExport(options: Partial<StandaloneHtmlExportOptions>) {
    const { stage, scenes, ...bytes } = setupNarratedClassroom();
    const result = await buildStandaloneHtmlExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
      includeNarration: true,
      zipDate: ZIP_DATE,
      ...options,
    });
    return { result, ...bytes };
  }

  const withoutExportTime = (html: string) => html.replace(/"exportedAt":"[^"]*"/g, '');

  async function readZip(blob: Blob) {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    const files = Object.keys(zip.files).sort();
    const bytes = async (path: string) => new Uint8Array(await zip.file(path)!.async('uint8array'));
    const text = async (path: string) => zip.file(path)!.async('string');
    return { zip, files, bytes, text };
  }

  /** Size of the ZIP's classroom.html for the narrated classroom (no ceiling). */
  async function zipPageBytes(options: Partial<StandaloneHtmlExportOptions> = {}) {
    const { result } = await narratedExport({ ...options, format: 'zip' });
    return (await readZip(result.blob)).bytes('classroom.html').then((page) => page.length);
  }

  it('ships classroom.html, a README, the images and each clip as files, stored uncompressed', async () => {
    const { result, AUDIO_BYTES, LEGACY_BYTES, VIDEO_BYTES } = await narratedExport({
      format: 'zip',
      zipReadme: 'Localized readme',
    });
    expect(result.format).toBe('zip');
    expect(result.fileName).toBe('Photosynthesis_ _Light_ & _Life_.zip');
    expect(result.blob.type).toBe('application/zip');
    expect(result.byteSize).toBe(result.blob.size);
    expect(result.missingAudioCount).toBe(1);
    expect(result.singleFileBytes).toBeUndefined();

    const { zip, files, bytes, text } = await readZip(result.blob);
    expect(files).toEqual([
      'README.txt',
      'audio/audio-1.mp3',
      'audio/legacy-1.mp3',
      'classroom.html',
      'images/image-1.png',
      'images/image-2.png',
      'images/image-3.png',
      'media/asset-2.mp4',
    ]);
    // Stored entries, in the order a reader extracts them: the page first.
    expect(Object.keys(zip.files)[0]).toBe('classroom.html');
    for (const entry of Object.values(zip.files)) {
      expect(
        (entry as unknown as { _data: { compression: { magic: string } } })._data.compression.magic,
      ).toBe('\x00\x00');
      expect(entry.date.getFullYear()).toBe(2026);
    }
    expect(await bytes('audio/audio-1.mp3')).toEqual(AUDIO_BYTES);
    expect(await bytes('audio/legacy-1.mp3')).toEqual(LEGACY_BYTES);
    expect(await bytes('media/asset-2.mp4')).toEqual(VIDEO_BYTES);
    for (const image of ['images/image-1.png', 'images/image-2.png', 'images/image-3.png']) {
      expect(await bytes(image)).toEqual(PNG_BYTES);
    }

    const readme = await text('README.txt');
    expect(readme.startsWith('﻿Localized readme\r\n\r\n')).toBe(true);
    expect(readme).toContain(STANDALONE_ZIP_README_EN);

    const html = await text('classroom.html');
    expect(embeddedJson<StandaloneMediaTable>(html, STANDALONE_MEDIA_TABLE_ELEMENT_ID)).toEqual({
      'audio/audio-1.mp3': { mimeType: 'audio/mpeg', src: 'audio/audio-1.mp3' },
      'audio/legacy-1.mp3': { mimeType: 'audio/mpeg', src: 'audio/legacy-1.mp3' },
      'media/asset-2.mp4': { mimeType: 'video/mp4', src: 'media/asset-2.mp4' },
    });
    expect(html).not.toContain('application/octet-stream');
    expect(html).not.toContain('data:image/png');
    expect(html).toContain(`content="${STANDALONE_HTML_LINKED_FILES_CSP}"`);
    expect(html).toContain("connect-src 'none'");
    // Every image slot and the poster name a shipped file by relative path.
    const manifest = embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID);
    const sources = [...imageSources(manifest)];
    const clip = slideOf(manifest).elements.find((e) => e.id === 'clip') as { poster?: string };
    expect(sources.length).toBeGreaterThan(0);
    for (const src of [...sources, clip.poster!]) expect(files).toContain(src);

    // Apart from the image sources, the manifest is the one the single file carries.
    const single = await narratedExport({ format: 'html' });
    const singleHtml = await single.result.blob.text();
    const singleManifest = embeddedJson<ClassroomManifest>(
      singleHtml,
      STANDALONE_MANIFEST_ELEMENT_ID,
    );
    const pathToUri = new Map<string, string>();
    imageSources(manifest).forEach((src, index) =>
      pathToUri.set(src, imageSources(singleManifest)[index]),
    );
    const inlined = JSON.parse(
      JSON.stringify(manifest).replace(/"images\/image-\d+\.png"/g, (match) =>
        JSON.stringify(
          pathToUri.get(JSON.parse(match)) ?? `data:image/png;base64,${FIXTURE_PNG_BASE64}`,
        ),
      ),
    );
    expect({ ...inlined, exportedAt: '' }).toEqual({ ...singleManifest, exportedAt: '' });
    expect(html).not.toContain('cdn.example');
  });

  it('estimates the single file from the linked manifest exactly as from the inlined one', async () => {
    const zip = await readZip((await narratedExport({ format: 'zip' })).result.blob);
    const linkedManifest = embeddedJson<ClassroomManifest>(
      await zip.text('classroom.html'),
      STANDALONE_MANIFEST_ELEMENT_ID,
    );
    const single = await (await narratedExport({ format: 'html' })).result.blob.text();
    const inlinedManifest = embeddedJson<ClassroomManifest>(single, STANDALONE_MANIFEST_ELEMENT_ID);
    const files = await Promise.all(
      zip.files
        .filter((path) => path.startsWith('images/'))
        .map(async (path) => ({
          path,
          blob: new Blob([await zip.bytes(path)], { type: 'image/png' }),
        })),
    );
    const payloads = [{ blob: new Blob([new Uint8Array(10)]) }];
    expect(estimateStandaloneHtmlBytes(linkedManifest, payloads, files)).toBe(
      estimateStandaloneHtmlBytes(inlinedManifest, payloads),
    );
  });

  it('auto keeps the single file, byte for byte, while it fits the ceiling', async () => {
    const auto = await narratedExport({ format: 'auto' });
    const html = await narratedExport({});
    expect(auto.result.format).toBe('html');
    expect(auto.result.fileName).toBe('Photosynthesis_ _Light_ & _Life_.html');
    expect(withoutExportTime(await auto.result.blob.text())).toBe(
      withoutExportTime(await html.result.blob.text()),
    );
    expect(auto.result.singleFileBytes).toBeUndefined();
  });

  it('auto builds the ZIP, without encoding any media, when the estimate passes the ceiling', async () => {
    // The estimate allows 1 MB for the player assets (here a few bytes), so a
    // ceiling just above the page puts the estimate over it.
    const maxBytes = (await zipPageBytes()) + 1000;
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    // Media payloads and images are typed; the CRC pass reads untyped slices.
    const typedReads = () =>
      read.mock.contexts.filter((blob) => /^(audio|video|image)\//.test((blob as Blob).type))
        .length;
    try {
      await narratedExport({ format: 'html' });
      expect(typedReads()).toBe(6); // 3 clips and 3 images base64-encoded for the single file
      read.mockClear();

      await expect(narratedExport({ format: 'html', maxBytes })).rejects.toMatchObject({
        name: 'StandaloneHtmlTooLargeError',
        kind: 'single-file',
      });
      read.mockClear();
      const { result } = await narratedExport({ format: 'auto', maxBytes });
      expect(result.format).toBe('zip');
      expect(result.singleFileBytes).toBeGreaterThan(maxBytes);
      expect(typedReads()).toBe(0);
      const { files } = await readZip(result.blob);
      expect(files).toContain('classroom.html');
    } finally {
      read.mockRestore();
    }
  });

  it('auto builds the ZIP when only the assembled document passes the ceiling', async () => {
    // A player larger than the estimate allows for: the estimate passes, the
    // assembled single file does not, and the ZIP's page (no inlined media) fits.
    const oversizedPlayer = 'x'.repeat(1.5 * 1024 * 1024);
    const withPlayer: Partial<StandaloneHtmlExportOptions> = {
      fetchAsset: async (assetPath: string) =>
        assetPath === STANDALONE_PLAYER_ASSETS.script ? oversizedPlayer : fetchAsset(assetPath),
    };
    const page = await zipPageBytes(withPlayer);
    const single = (await narratedExport({ ...withPlayer, format: 'html' })).result.byteSize;
    expect(single).toBeGreaterThan(page);
    const maxBytes = Math.floor((page + single) / 2);
    const { result } = await narratedExport({ ...withPlayer, format: 'auto', maxBytes });
    expect(result.format).toBe('zip');
    expect(result.singleFileBytes).toBe(single);
  });

  it('refuses, as a page too large, a ZIP whose classroom.html alone passes the ceiling', async () => {
    const page = await zipPageBytes();
    const attempt = narratedExport({ format: 'auto', maxBytes: page - 1 });
    await expect(attempt).rejects.toBeInstanceOf(StandaloneHtmlTooLargeError);
    await expect(attempt).rejects.toMatchObject({ kind: 'page', estimatedBytes: page });
    await expect(narratedExport({ format: 'auto', maxBytes: page })).resolves.toMatchObject({
      result: { format: 'zip' },
    });
  });

  it('ships the images of a classroom without playback media, with no media table', async () => {
    const scenes = standaloneFixtureScenes(STAGE_ID);
    const stage = setupSnapshot(scenes);
    const result = await buildStandaloneHtmlExport(stage, scenes, {
      strings,
      lang: 'en-US',
      fetchAsset,
      fetchImage,
      format: 'zip',
    });
    const { files, text } = await readZip(result.blob);
    expect(files).toEqual([
      'README.txt',
      'classroom.html',
      'images/image-1.png',
      'images/image-2.png',
    ]);
    const html = await text('classroom.html');
    expect(html).not.toContain(STANDALONE_MEDIA_TABLE_ELEMENT_ID);
    expect(html).toContain(`content="${STANDALONE_HTML_LINKED_FILES_CSP}"`);
  });

  it('never lets a file overwrite classroom.html or README.txt, or leave the folder', async () => {
    const page = {
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
      playerScript: '',
      playerStyle: '',
      lang: 'en-US',
    };
    const blob = new Blob(['x'], { type: 'audio/mpeg' });
    for (const key of ['classroom.html', 'README.txt', '../evil.mp3', '/abs.mp3']) {
      await expect(
        buildStandaloneZip(page, { payloads: [{ key, mimeType: 'audio/mpeg', blob }] }),
      ).rejects.toThrow(/unusable file path/);
    }
    await expect(
      buildStandaloneZip(page, {
        payloads: [{ key: 'images/a.png', mimeType: 'image/png', blob }],
        files: [{ path: 'images/a.png', blob }],
      }),
    ).rejects.toThrow(/unusable file path/);
  });

  it('refuses, before computing any CRC, an archive above 4 GiB', async () => {
    const huge = new Blob(['x'], { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: 0xffffffff });
    const slice = vi.spyOn(huge, 'slice');
    const attempt = buildStandaloneZip(
      {
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
        playerScript: '',
        playerStyle: '',
        lang: 'en-US',
      },
      { payloads: [{ key: 'media/huge.mp4', mimeType: 'video/mp4', blob: huge }] },
    );
    await expect(attempt).rejects.toMatchObject({
      name: 'StandaloneHtmlTooLargeError',
      kind: 'archive',
    });
    expect(slice).not.toHaveBeenCalled();
  });

  describe('image sources', () => {
    const PNG_URI = `data:image/png;base64,${FIXTURE_PNG_BASE64}`;
    const SVG_URI = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>')}`;
    const OTHER_URI = 'data:application/x-unknown;base64,AAAA';
    const STORED = Uint8Array.from([1, 2, 3, 4, 5, 6]);

    function manifestWith(elements: unknown[], background?: unknown): ClassroomManifest {
      return {
        formatVersion: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        appVersion: '',
        stage: { name: 'x', createdAt: 0, updatedAt: 0 },
        agents: [],
        mediaIndex: {
          'media/asset-1.png': {
            type: 'generated',
            sourceRef: 'img_stored',
            mimeType: 'image/png',
          },
          'media/asset-2.png': { type: 'generated', sourceRef: 'img_chart', mimeType: 'image/png' },
        },
        scenes: [
          {
            type: 'slide',
            title: 's',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: 's',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme: {
                  backgroundColor: '#fff',
                  themeColors: ['#000'],
                  fontColor: '#000',
                  fontName: 'Arial',
                },
                elements,
                ...(background ? { background } : {}),
              },
            },
          },
        ],
      } as unknown as ClassroomManifest;
    }
    const box = { left: 0, top: 0, width: 10, height: 10, rotate: 0 };
    const elements = [
      { ...box, type: 'image', id: 'a', src: PNG_URI, fixedRatio: true },
      { ...box, type: 'image', id: 'b', src: PNG_URI, fixedRatio: true },
      { ...box, type: 'image', id: 'c', src: OTHER_URI, fixedRatio: true },
      { ...box, type: 'image', id: 'd', src: 'img_stored', fixedRatio: true },
      {
        ...box,
        type: 'shape',
        id: 'e',
        viewBox: [1, 1],
        path: 'M0 0',
        fixedRatio: false,
        fill: '#000',
        pattern: SVG_URI,
      },
      { ...box, type: 'video', id: 'f', src: '', poster: PNG_URI, autoplay: false },
      {
        ...box,
        type: 'chart',
        id: 'g',
        chartType: 'bar',
        data: { labels: ['a'], legends: ['l'], series: [[1]] },
        themeColors: ['#000'],
        importedStyle: {
          series: [{ pointImages: { '0': 'img_chart', '1': PNG_URI, '2': 'img_stored' } }],
        },
      },
    ];
    const background = { type: 'image', image: { src: SVG_URI, size: 'cover' } };

    async function prepareBoth() {
      const manifest = manifestWith(elements, background);
      const snapshot = {
        manifest,
        files: new Map([
          ['media/asset-1.png', new Blob([STORED], { type: 'image/png' })],
          ['media/asset-2.png', new Blob([PNG_BYTES], { type: 'image/png' })],
        ]),
        videoPosters: new Map<string, Blob>(),
      };
      const bytes = await collectStandaloneMediaBytes(snapshot, { fetchImage: async () => null });
      const linked = await linkStandaloneImages(bytes, manifest);
      return {
        linked,
        zip: prepareStandaloneManifest(manifest, linked.resolution),
        single: prepareStandaloneManifest(manifest, await encodeStandaloneImages(bytes)),
      };
    }
    const elementOf = (manifest: ClassroomManifest, id: string) =>
      slideOf(manifest).elements.find((element) => element.id === id) as unknown as Record<
        string,
        unknown
      >;

    it('keeps chart point images inline in the ZIP: the chart wraps them in a data: SVG', async () => {
      const { linked, zip, single } = await prepareBoth();
      const points = (manifest: ClassroomManifest) =>
        (elementOf(manifest, 'g').importedStyle as { series: Array<{ pointImages: object }> })
          .series[0].pointImages;
      expect(points(zip.manifest)).toEqual({
        '0': PNG_URI,
        '1': PNG_URI,
        '2': `data:image/png;base64,${Buffer.from(STORED).toString('base64')}`,
      });
      expect(points(zip.manifest)).toEqual(points(single.manifest));
      // A ref named only by a chart (img_chart) ships no file; one also shown
      // as an image (img_stored) does: the stored image, the SVG and the PNG URI.
      expect(linked.files).toHaveLength(3);
      expect(elementOf(zip.manifest, 'd').src).toMatch(/^images\/image-\d+\.png$/);
    });

    it('ships inline data: images, backgrounds, patterns and posters as files in the ZIP, once per URI', async () => {
      const { linked, zip, single } = await prepareBoth();
      const pathOf = (id: string, key = 'src') => elementOf(zip.manifest, id)[key] as string;
      expect(pathOf('a')).toMatch(/^images\/image-\d+\.png$/);
      expect(pathOf('b')).toBe(pathOf('a'));
      expect(pathOf('f', 'poster')).toBe(pathOf('a'));
      expect(pathOf('e', 'pattern')).toMatch(/^images\/image-\d+\.svg$/);
      const zipBackground = slideOf(zip.manifest).background as { image: { src: string } };
      expect(zipBackground.image.src).toBe(pathOf('e', 'pattern'));
      // A MIME type no file extension conveys stays inline.
      expect(pathOf('c')).toBe(OTHER_URI);
      expect(linked.files.map((file) => file.path).sort()).toEqual([
        'images/image-1.png',
        'images/image-2.svg',
        'images/image-3.png',
      ]);
      const fileAt = (path: string) => linked.files.find((file) => file.path === path)!.blob;
      expect(new Uint8Array(await fileAt(pathOf('a')).arrayBuffer())).toEqual(PNG_BYTES);
      expect(await fileAt(pathOf('e', 'pattern')).text()).toContain('<rect width="4"');
      expect(fileAt(pathOf('e', 'pattern')).type).toBe('image/svg+xml');
      expect(JSON.stringify(zip.manifest)).not.toContain(SVG_URI);

      // The single file keeps every inline source exactly as it was.
      expect(elementOf(single.manifest, 'a').src).toBe(PNG_URI);
      expect(elementOf(single.manifest, 'e').pattern).toBe(SVG_URI);
      expect((slideOf(single.manifest).background as { image: { src: string } }).image.src).toBe(
        SVG_URI,
      );
      expect(elementOf(single.manifest, 'f').poster).toBe(PNG_URI);
      expect(zip.unresolved).toEqual(single.unresolved);

      // The single file's size is still estimated exactly from the ZIP's manifest.
      expect(estimateStandaloneHtmlBytes(zip.manifest, [], linked.files)).toBe(
        estimateStandaloneHtmlBytes(single.manifest, []),
      );
    });

    it('leaves inline data: images undecoded when the ZIP is not being built, with the same estimate', async () => {
      const manifest = manifestWith(elements, background);
      const snapshot = {
        manifest,
        files: new Map([
          ['media/asset-1.png', new Blob([STORED], { type: 'image/png' })],
          ['media/asset-2.png', new Blob([PNG_BYTES], { type: 'image/png' })],
        ]),
        videoPosters: new Map<string, Blob>(),
      };
      const bytes = await collectStandaloneMediaBytes(snapshot, { fetchImage: async () => null });
      const full = await linkStandaloneImages(bytes, manifest);
      const lazy = await linkStandaloneImages(bytes, manifest, { decodeInline: false });
      // Only the stored (non-inline) images become files; inline sources stay as they are.
      expect(lazy.files.length).toBeLessThan(full.files.length);
      const lazyManifest = prepareStandaloneManifest(manifest, lazy.resolution).manifest;
      expect(elementOf(lazyManifest, 'a').src).toBe(PNG_URI);
      const fullManifest = prepareStandaloneManifest(manifest, full.resolution).manifest;
      expect(estimateStandaloneHtmlBytes(lazyManifest, [], lazy.files)).toBe(
        estimateStandaloneHtmlBytes(fullManifest, [], full.files),
      );
    });

    it('decodes only well-formed image data: URIs', () => {
      expect(decodeImageDataUri(PNG_URI)?.type).toBe('image/png');
      expect(decodeImageDataUri('data:image/png;base64,@@@')).toBeUndefined();
      expect(decodeImageDataUri(OTHER_URI)).toBeUndefined();
      expect(decodeImageDataUri('data:image/svg+xml,%E0%A4%A')).toBeUndefined();
      expect(decodeImageDataUri('not a data uri')).toBeUndefined();
    });

    it('a classroom whose image is already a data: URI ships it as a file in the ZIP', async () => {
      const scenes = standaloneFixtureScenes(STAGE_ID).map((scene) =>
        withSlideElements(
          scene,
          (existing) =>
            [
              ...existing,
              { ...box, type: 'image', id: 'inline', src: PNG_URI, fixedRatio: true },
            ] as PPTElement[],
        ),
      );
      const stage = setupSnapshot(scenes);
      const options = { strings, lang: 'en-US', fetchAsset, fetchImage } as const;
      const result = await buildStandaloneHtmlExport(stage, scenes, { ...options, format: 'zip' });
      const { files, text, bytes } = await readZip(result.blob);
      const html = await text('classroom.html');
      expect(html).not.toContain(FIXTURE_PNG_BASE64);
      const inline = slideOf(
        embeddedJson<ClassroomManifest>(html, STANDALONE_MANIFEST_ELEMENT_ID),
      ).elements.find((element) => element.id === 'inline') as { src: string };
      expect(files).toContain(inline.src);
      expect(await bytes(inline.src)).toEqual(PNG_BYTES);
      const single = await buildStandaloneHtmlExport(setupSnapshot(scenes), scenes, options);
      expect(await single.blob.text()).toContain(`"src":"${PNG_URI}"`);
    });
  });

  it('encodes each path segment of a linked source', () => {
    expect(linkedMediaSrc('media/asset-1.mp4')).toBe('media/asset-1.mp4');
    expect(linkedMediaSrc('media/a b#?.mp4')).toBe('media/a%20b%23%3F.mp4');
  });

  it('writes the README in the UI locale, then English, once', () => {
    expect(standaloneZipReadme()).toBe(`﻿${STANDALONE_ZIP_README_EN}\r\n`);
    expect(standaloneZipReadme(STANDALONE_ZIP_README_EN)).toBe(standaloneZipReadme());
    expect(standaloneZipReadme('先解压')).toBe(`﻿先解压\r\n\r\n${STANDALONE_ZIP_README_EN}\r\n`);
    const en = JSON.parse(
      readFileSync(path.join(process.cwd(), 'lib/i18n/locales/en-US.json'), 'utf8'),
    ) as { export: { htmlZipReadme: string } };
    expect(en.export.htmlZipReadme).toBe(STANDALONE_ZIP_README_EN);
  });
});
