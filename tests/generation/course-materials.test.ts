// @vitest-environment jsdom
/**
 * The composer's course materials: each attached file uploads and is
 * extracted before Generate (the chip shows uploading, parsing or
 * transcribing, ready, or failed with its reason and Retry), Generate waits
 * for every one, and what a course leaves out of a material is said on its
 * chip (the preview lists no material step: see preview-material-step).
 */
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

import enUS from '@/lib/i18n/locales/en-US.json';

let i18n: I18n;
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options ?? {}),
    locale: 'en-US',
  }),
}));

const api = vi.hoisted(() => ({
  uploadMaterial: vi.fn(),
  fetchOwnerMaterial: vi.fn(),
  retryMaterialExtraction: vi.fn(),
  deleteMaterial: vi.fn(),
  fetchMaterialPolicy: vi.fn(),
}));
vi.mock('@/lib/generation-run-client/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation-run-client/api')>()),
  ...api,
}));

import { CourseMaterialChip } from '@/components/generation/generation-toolbar';
import { RunApiError, type MaterialPolicy } from '@/lib/generation-run-client/api';
import {
  combinedTruncation,
  policyRefusal,
  useCourseMaterials,
  type CourseMaterialEntry,
  type CourseMaterials,
} from '@/lib/generation-run-client/use-course-materials';

const POLICY: MaterialPolicy = {
  formats: [{ mime: 'application/pdf' }, { mime: 'text/plain' }, { mime: 'audio/mpeg' }],
  maxCount: 2,
  maxTotalBytes: 100,
  maxDocumentBytes: 40,
  maxMediaBytes: 90,
};

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  });
});

function entry(overrides: Partial<CourseMaterialEntry> = {}): CourseMaterialEntry {
  const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
  return {
    id: 'a',
    file,
    name: 'notes.pdf',
    size: 2 * 1024 * 1024,
    lastModified: 1,
    type: 'application/pdf',
    order: 1,
    status: 'ready',
    progress: 1,
    mediaKind: 'document',
    ...overrides,
  };
}

const chip = (material: CourseMaterialEntry) =>
  renderToStaticMarkup(
    createElement(CourseMaterialChip, {
      material,
      locked: false,
      onRemove: () => {},
      onRetry: () => {},
    }),
  );

describe('the material chip', () => {
  it('shows the upload progress as a bar along its edge', () => {
    const markup = chip(entry({ status: 'uploading', progress: 0.42 }));
    expect(markup).toContain('Uploading 42%');
    expect(markup).toContain('width:42%');
    expect(markup).toContain('data-status="uploading"');
    expect(markup).not.toContain('Retry');
  });

  it('says parsing for a document and transcribing for audio or video', () => {
    const document = chip(entry({ status: 'extracting' }));
    expect(document).toContain('Parsing…');
    expect(document).toContain('lucide-file-text');
    const media = chip(
      entry({
        status: 'extracting',
        mediaKind: 'media',
        name: 'talk.mp4',
        type: 'video/mp4',
      }),
    );
    expect(media).toContain('Transcribing…');
    expect(media).toContain('Audio/video');
    expect(media).toContain('lucide-file-play');
  });

  it('shows ready with the size, and the type of file by its icon', () => {
    const markup = chip(entry());
    expect(markup).toContain('Ready');
    expect(markup).toContain('2.0 MB');
    expect(markup).not.toContain('width:');
    expect(chip(entry({ name: 'deck.pptx', size: 300 * 1024 }))).toContain('lucide-presentation');
    expect(chip(entry({ name: 'deck.pptx', size: 300 * 1024 }))).toContain('300 KB');
    expect(chip(entry({ name: 'sheet.xlsx' }))).toContain('lucide-file-spreadsheet');
    expect(chip(entry({ name: 'photo.png', type: 'image/png' }))).toContain('lucide-file-image');
  });

  it('shows what a course leaves out of a ready material', () => {
    const markup = chip(
      entry({
        extraction: {
          status: 'ready',
          truncated: { textChars: 49_000, images: { total: 30, max: 20 } },
        },
      }),
    );
    expect(markup).toContain('Ready');
    expect(markup).toContain('using first 49000 characters');
    expect(markup).toContain('30 images found');
  });

  it('shows a failure with its reason, Retry and Remove', () => {
    const markup = chip(
      entry({
        status: 'failed',
        failure: { stage: 'extraction', text: 'document extraction failed (unpdf: no text)' },
      }),
    );
    expect(markup).toContain('Failed · document extraction failed (unpdf: no text)');
    expect(markup).toContain('text-destructive');
    expect(markup).toContain('aria-label="Retry"');
    expect(markup).toContain('aria-label="Remove file"');
    // A failure without a reason of its own just says it failed.
    expect(
      chip(
        entry({
          status: 'failed',
          failure: { stage: 'extraction', key: 'toolbar.materialFailed' },
        }),
      ),
    ).not.toContain('Failed · ');
  });

  it('disables Retry and Remove while the materials are locked', () => {
    const markup = renderToStaticMarkup(
      createElement(CourseMaterialChip, {
        material: entry({ status: 'failed', failure: { stage: 'upload', text: 'x' } }),
        locked: true,
        onRemove: () => {},
        onRetry: () => {},
      }),
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('what the materials leave out together', () => {
  const ready = (id: string, textChars: number, imageCount = 0) =>
    entry({ id, name: `${id}.pdf`, extraction: { status: 'ready', textChars, imageCount } });

  it('is nothing for one material (its chip says it) or when they fit', () => {
    expect(combinedTruncation([ready('a', 90_000)])).toBeNull();
    expect(combinedTruncation([ready('a', 100), ready('b', 100)])).toBeNull();
  });

  it('is the shared budget when they only overflow together', () => {
    const together = combinedTruncation([ready('a', 30_000, 12), ready('b', 30_000, 12)]);
    expect(together?.textChars).toBeGreaterThan(0);
    expect(together?.textChars).toBeLessThan(60_000);
    expect(together?.images).toEqual({ total: 24, max: 20 });
  });
});

describe('the attach-time policy', () => {
  const file = (name: string, type: string, size: number) =>
    new File([new Uint8Array(size)], name, { type });

  it('refuses unsupported types, oversize files, too many and too much', () => {
    expect(policyRefusal(POLICY, [], [file('a.exe', 'application/x-msdownload', 1)])).toEqual({
      key: 'upload.unsupportedMaterialFormat',
    });
    expect(policyRefusal(POLICY, [], [file('a.pdf', 'application/pdf', 41)])?.key).toBe(
      'upload.materialTooLarge',
    );
    // Audio has the media cap.
    expect(policyRefusal(POLICY, [], [file('a.mp3', 'audio/mpeg', 60)])).toBeNull();
    expect(
      policyRefusal(POLICY, [{ size: 1 }, { size: 1 }], [file('a.pdf', 'application/pdf', 1)]),
    ).toEqual({ key: 'upload.courseMaterialCountLimit', values: { n: 2 } });
    expect(policyRefusal(POLICY, [{ size: 70 }], [file('a.pdf', 'application/pdf', 35)])?.key).toBe(
      'upload.courseMaterialTotalSizeLimit',
    );
  });
});

describe('the composer materials', () => {
  let root: Root;
  const probe: { current?: CourseMaterials } = {};
  function Probe(): ReactNode {
    const materials = useCourseMaterials();
    useEffect(() => {
      probe.current = materials;
    });
    return null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of Object.values(api)) mock.mockReset();
    api.fetchMaterialPolicy.mockResolvedValue(POLICY);
    api.deleteMaterial.mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  const pdf = () => new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
  const flush = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('uploads on attach, polls the extraction, and is ready for Generate', async () => {
    api.uploadMaterial.mockImplementation(async (_file, { onProgress }) => {
      onProgress(0.5);
      return {
        materialId: 'mat_1',
        bytes: 4,
        mediaKind: 'document',
        extraction: { status: 'extracting' },
      };
    });
    api.fetchOwnerMaterial.mockResolvedValue({
      materialId: 'mat_1',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'ready', textChars: 4 },
    });
    await act(async () => {
      expect(await probe.current!.add([pdf()])).toBeNull();
    });
    await flush();
    expect(probe.current!.materials[0]).toMatchObject({
      status: 'extracting',
      materialId: 'mat_1',
    });
    expect(probe.current!.allReady).toBe(false);
    await flush(1600);
    expect(probe.current!.materials[0]).toMatchObject({ status: 'ready' });
    expect(probe.current!.allReady).toBe(true);
    expect(probe.current!.handOff()).toEqual(['mat_1']);
    // Handed to a run: leaving the composer does not delete it.
    await act(async () => root.unmount());
    expect(api.deleteMaterial).not.toHaveBeenCalled();
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
  });

  it('refuses what the policy refuses, uploading nothing', async () => {
    await act(async () => {
      expect(
        await probe.current!.add([
          new File([new Uint8Array(50)], 'big.pdf', { type: 'application/pdf' }),
        ]),
      ).toMatchObject({ key: 'upload.materialTooLarge' });
    });
    expect(api.uploadMaterial).not.toHaveBeenCalled();
    expect(probe.current!.materials).toEqual([]);
  });

  it('retries a failed upload and a failed extraction, and deletes what it removes', async () => {
    api.uploadMaterial.mockRejectedValueOnce(
      new RunApiError(500, undefined, undefined, 'upload.materialUploadFailed', {
        name: 'notes.pdf',
      }),
    );
    await act(async () => {
      await probe.current!.add([pdf()]);
    });
    await flush();
    expect(probe.current!.materials[0]).toMatchObject({
      status: 'failed',
      failure: { stage: 'upload', key: 'upload.materialUploadFailed' },
    });

    api.uploadMaterial.mockResolvedValueOnce({
      materialId: 'mat_2',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'failed', error: 'no text' },
    });
    await act(async () => probe.current!.retry(probe.current!.materials[0]!.id));
    await flush();
    expect(probe.current!.materials[0]).toMatchObject({
      status: 'failed',
      materialId: 'mat_2',
      failure: { stage: 'extraction', text: 'no text' },
    });

    api.retryMaterialExtraction.mockResolvedValueOnce({
      materialId: 'mat_2',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'extracting' },
    });
    await act(async () => probe.current!.retry(probe.current!.materials[0]!.id));
    await flush();
    expect(api.retryMaterialExtraction).toHaveBeenCalledWith('mat_2');
    expect(probe.current!.materials[0]).toMatchObject({ status: 'extracting' });

    await act(async () => probe.current!.remove(probe.current!.materials[0]!.id));
    expect(api.deleteMaterial).toHaveBeenCalledWith('mat_2');
    expect(probe.current!.materials).toEqual([]);
    expect(probe.current!.allReady).toBe(true);
  });

  it('deletes what no run took when the composer goes away', async () => {
    api.uploadMaterial.mockResolvedValue({
      materialId: 'mat_3',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'extracting' },
    });
    await act(async () => {
      await probe.current!.add([pdf()]);
    });
    await flush();
    await act(async () => root.unmount());
    expect(api.deleteMaterial).toHaveBeenCalledWith('mat_3', { keepalive: true });
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
  });

  it('shows the chip (and holds Generate) before the policy is read, and withdraws it on a refusal', async () => {
    let answer!: (policy: MaterialPolicy) => void;
    api.fetchMaterialPolicy.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let adding!: Promise<unknown>;
    await act(async () => {
      adding = probe.current!.add([
        new File([new Uint8Array(50)], 'big.pdf', { type: 'application/pdf' }),
      ]);
    });
    expect(probe.current!.materials).toHaveLength(1);
    expect(probe.current!.allReady).toBe(false);
    await act(async () => {
      answer(POLICY);
      await adding;
    });
    expect(await adding).toMatchObject({ key: 'upload.materialTooLarge' });
    expect(probe.current!.materials).toEqual([]);
    expect(probe.current!.allReady).toBe(true);
    expect(api.uploadMaterial).not.toHaveBeenCalled();
  });

  it('follows an extraction that was already restarted when its Retry answers 409', async () => {
    api.uploadMaterial.mockResolvedValue({
      materialId: 'mat_4',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'failed', error: 'no text' },
    });
    await act(async () => {
      await probe.current!.add([pdf()]);
    });
    await flush();
    api.retryMaterialExtraction.mockRejectedValue(
      new RunApiError(409, 'INVALID_REQUEST', 'extracting', 'upload.materialUploadFailed'),
    );
    api.fetchOwnerMaterial.mockResolvedValue({
      materialId: 'mat_4',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'ready', textChars: 4 },
    });
    await act(async () => probe.current!.retry(probe.current!.materials[0]!.id));
    await flush();
    expect(probe.current!.materials[0]).toMatchObject({ status: 'extracting' });
    await flush(1600);
    expect(probe.current!.materials[0]).toMatchObject({ status: 'ready' });
  });

  it('reads its materials back while open (keeping them in use), and Generate checks they still exist', async () => {
    api.uploadMaterial.mockResolvedValue({
      materialId: 'mat_6',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'ready' },
    });
    await act(async () => {
      await probe.current!.add([pdf()]);
    });
    await flush();
    api.fetchOwnerMaterial.mockResolvedValue({
      materialId: 'mat_6',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'ready' },
    });
    await flush(10 * 60 * 1000);
    expect(api.fetchOwnerMaterial).toHaveBeenCalledWith('mat_6');
    expect(probe.current!.materials[0]).toMatchObject({ status: 'ready' });

    // Handed to a run, then found gone: the start is refused and the chip says so.
    expect(probe.current!.handOff()).toEqual(['mat_6']);
    api.fetchOwnerMaterial.mockResolvedValue(null);
    let present: boolean | undefined;
    await act(async () => {
      present = await probe.current!.verify();
    });
    expect(present).toBe(false);
    expect(probe.current!.materials[0]).toMatchObject({
      status: 'failed',
      failure: { key: 'toolbar.materialUnavailable' },
    });
    expect(probe.current!.allReady).toBe(false);
  });

  it('keeps its materials when the page goes into the back/forward cache, and reconciles them on return', async () => {
    api.uploadMaterial.mockResolvedValue({
      materialId: 'mat_5',
      bytes: 4,
      mediaKind: 'document',
      extraction: { status: 'ready' },
    });
    await act(async () => {
      await probe.current!.add([pdf()]);
    });
    await flush();
    const page = (type: string, persisted: boolean) => {
      const event = new Event(type) as PageTransitionEvent;
      Object.defineProperty(event, 'persisted', { value: persisted });
      return event;
    };
    await act(async () => void window.dispatchEvent(page('pagehide', true)));
    expect(api.deleteMaterial).not.toHaveBeenCalled();
    // Swept while the page was away.
    api.fetchOwnerMaterial.mockResolvedValue(null);
    await act(async () => void window.dispatchEvent(page('pageshow', true)));
    await flush();
    expect(probe.current!.materials[0]).toMatchObject({
      status: 'failed',
      failure: { key: 'toolbar.materialUnavailable' },
    });
    // A real unload releases what is left.
    await act(async () => void window.dispatchEvent(page('pagehide', false)));
    expect(api.deleteMaterial).toHaveBeenCalledWith('mat_5', { keepalive: true });
  });
});
