import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hook-level run of both PPTX exports with the real English strings: the
// placeholders link to the online classroom without asking the server
// anything about it.

const enUS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../lib/i18n/locales/en-US.json'), 'utf8'),
);
function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = enUS;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  let text = typeof value === 'string' ? value : key;
  for (const [name, v] of Object.entries(options ?? {}))
    text = text.replace(`{{${name}}}`, String(v));
  return text;
}

const mocks = vi.hoisted(() => ({
  stageState: { stage: null as unknown, scenes: [] as unknown[] },
  saveAs: vi.fn(),
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, () => {}] as const,
}));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/store', () => ({
  useStageStore: (selector: (state: typeof mocks.stageState) => unknown) =>
    selector(mocks.stageState),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 0.5625 } },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { get: vi.fn().mockResolvedValue(undefined) } },
}));
vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: vi.fn().mockResolvedValue(null), release: vi.fn() }),
}));

import { useExportPPTX } from '@/lib/export/use-export-pptx';

const canvas = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    fontName: 'Arial',
    fontColor: '#111111',
    backgroundColor: '#ffffff',
    themeColors: ['#2255aa'],
  },
  background: { type: 'solid', color: '#ffffff' },
  elements: [],
};
const scene = (id: string, type: string, content: unknown) => ({
  id,
  stageId: 'stage-1',
  type,
  title: `Scene ${id}`,
  order: 0,
  content,
  actions: [],
});

const ORIGIN = 'https://host.example';
const sceneUrl = (id: string) => `${ORIGIN}/classroom/stage-1?scene=${id}`;

async function savedPptx(): Promise<JSZip> {
  const blob = mocks.saveAs.mock.calls.at(-1)![0] as Blob;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const inner = zip.file('Course.pptx');
  return inner ? JSZip.loadAsync(await inner.async('uint8array')) : zip;
}

async function runExport(action: () => void) {
  action(); // the export guard defers the work by 100 ms
  await vi.waitFor(
    () => {
      if (mocks.toast.error.mock.calls.length) throw new Error('export failed');
      expect(mocks.toast.success).toHaveBeenCalled();
    },
    { timeout: 4_000 },
  );
}

describe('useExportPPTX placeholders', () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    mocks.stageState.stage = { id: 'stage-1', name: 'Course' };
    mocks.stageState.scenes = [
      scene('s1', 'slide', { type: 'slide', canvas }),
      scene('i1', 'interactive', { type: 'interactive', url: '', html: '<p>page</p>' }),
      scene('q1', 'quiz', {
        type: 'quiz',
        questions: [{ id: 'a', type: 'single', question: 'Which planet is largest?' }],
      }),
    ];
  });

  for (const mode of ['exportPPTX', 'exportResourcePack'] as const) {
    it(`${mode}: links placeholders online, makes no request, shows no publish wording`, async () => {
      const hook = useExportPPTX({ classroomOrigin: ORIGIN });
      await runExport(() => hook[mode]({ includePlaceholders: true }));

      expect(fetchSpy).not.toHaveBeenCalled();
      const pptx = await savedPptx();
      for (const [slideNumber, id] of [
        [2, 'i1'],
        [3, 'q1'],
      ] as const) {
        const xml = await pptx.file(`ppt/slides/slide${slideNumber}.xml`)!.async('string');
        const rels = await pptx
          .file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)!
          .async('string');
        expect(xml).toContain(translate('export.placeholder.openOnline'));
        expect(rels).toContain(`Target="${sceneUrl(id)}" TargetMode="External"`);
        expect(rels).toMatch(/relationships\/image" Target="\.\.\/media\/[^"]+\.png"/);
        expect(xml).not.toMatch(/publish|public/i);
      }
    });
  }

  it('leaves the online link out when the stage has no id', async () => {
    mocks.stageState.stage = { name: 'Course' };
    const hook = useExportPPTX({ classroomOrigin: ORIGIN });
    // No choice passed: placeholders are the default.
    await runExport(() => hook.exportPPTX());

    expect(fetchSpy).not.toHaveBeenCalled();
    const pptx = await savedPptx();
    const xml = await pptx.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).not.toContain(translate('export.placeholder.openOnline'));
  });

  it('exports the slide scenes only when slides only is chosen', async () => {
    const hook = useExportPPTX({ classroomOrigin: ORIGIN });
    await runExport(() => hook.exportPPTX({ includePlaceholders: false }));

    const pptx = await savedPptx();
    expect(pptx.file('ppt/slides/slide1.xml')).not.toBeNull();
    expect(pptx.file('ppt/slides/slide2.xml')).toBeNull();
  });

  it('reports no slides when slides only is chosen and the lesson has none', async () => {
    mocks.stageState.scenes = mocks.stageState.scenes.slice(1);
    const hook = useExportPPTX({ classroomOrigin: ORIGIN });
    hook.exportPPTX({ includePlaceholders: false });

    expect(mocks.toast.warning).toHaveBeenCalledWith(translate('export.noSlides'));
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('ships the HTML pages alone from a slides-only Resource Pack of a lesson without slides', async () => {
    mocks.stageState.scenes = mocks.stageState.scenes.slice(1);
    const hook = useExportPPTX({ classroomOrigin: ORIGIN });
    await runExport(() => hook.exportResourcePack({ includePlaceholders: false }));

    expect(mocks.toast.info).toHaveBeenCalledWith(translate('export.noSlidesSkipped'));
    const blob = mocks.saveAs.mock.calls.at(-1)![0] as Blob;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(files).toEqual(['interactive/01_Scene i1.html']);
  });
});
