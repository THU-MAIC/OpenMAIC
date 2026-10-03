// @vitest-environment jsdom
/**
 * The composer's course materials: each attached file uploads and is
 * extracted before Generate (the chip shows uploading, parsing or
 * transcribing, ready, or failed with its reason and Retry), Generate waits
 * for every one, and what a course leaves out of a material is said on its
 * chip instead of in the preview.
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
import { previewStepIds, showsMaterialAnalysis } from '@/lib/generation-run-client/preview-steps';
import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import {
  combinedTruncation,
  policyRefusal,
  useCourseMaterials,
  type CourseMaterialEntry,
  type CourseMaterials,
} from '@/lib/generation-run-client/use-course-materials';
import type { RunSnapshot } from '@/lib/generation-run-client/types';

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
  it('shows the upload progress', () => {
    const markup = chip(entry({ status: 'uploading', progress: 0.42 }));
    expect(markup).toContain('Uploading 42%');
    expect(markup).toContain('width:42%');
  });

  it('says parsing for a document and transcribing for audio or video', () => {
    expect(chip(entry({ status: 'extracting' }))).toContain('Parsing…');
    const media = chip(entry({ status: 'extracting', mediaKind: 'media' }));
    expect(media).toContain('Transcribing…');
    expect(media).toContain('Audio/video');
  });

  it('shows ready with what a course leaves out of the material', () => {
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

  it('shows a failure with its reason and Retry', () => {
    const markup = chip(
      entry({
        status: 'failed',
        failure: { stage: 'extraction', text: 'document extraction failed (unpdf: no text)' },
      }),
    );
    expect(markup).toContain('Failed');
    expect(markup).toContain('document extraction failed (unpdf: no text)');
    expect(markup).toContain('Retry');
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
});

describe('the preview of a run started from ready materials', () => {
  const snapshot: RunSnapshot = {
    id: 'run-1',
    state: 'preparing',
    step: null,
    seq: 0,
    input: { materialIds: ['mat_1'], agents: { mode: 'preset', agentIds: [] } },
    outline: null,
    agents: null,
    stageId: null,
    progress: { scenesTotal: 0, scenesCompleted: 0 },
    error: null,
    createdAt: '',
    updatedAt: '',
  } as unknown as RunSnapshot;
  const steps = (view: ReturnType<typeof viewFromSnapshot>) =>
    previewStepIds({
      hasMaterials: showsMaterialAnalysis(view),
      webSearch: false,
      autoAgents: false,
    });

  it('has no analysis step when the run waited for nothing', () => {
    let view = viewFromSnapshot(snapshot);
    view = applyRunEvent(view, {
      seq: 1,
      type: 'step_started',
      data: { step: 'material-analysis' },
    } as never);
    expect(steps(view)).not.toContain('pdf-analysis');
  });

  it('keeps it while the run waits for an extraction', () => {
    let view = viewFromSnapshot(snapshot);
    view = applyRunEvent(view, {
      seq: 1,
      type: 'material_kinds',
      data: { kinds: ['document'] },
    } as never);
    expect(steps(view)).toContain('pdf-analysis');
    view = applyRunEvent(view, {
      seq: 2,
      type: 'step_completed',
      data: { step: 'material-analysis' },
    } as never);
    expect(steps(view)).not.toContain('pdf-analysis');
  });
});
