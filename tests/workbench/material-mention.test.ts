// @vitest-environment jsdom
/**
 * The composer's knowledge-base picker (RFC #1716 §4): rows from the library,
 * a pick staged as one more pill (never attached before sending, never twice,
 * within the per-message cap), the `@` menu walking classrooms and materials
 * as one list, and the listing refetched on a material change of the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}${JSON.stringify(values)}` : key,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { CourseMentionMenu } from '@/components/workbench/course-mention-menu';
import {
  useComposerMaterials,
  useMaterialMentions,
  type ComposerMaterials,
} from '@/components/workbench/compose-extras';
import {
  MATERIAL_MENTION_LIMIT,
  materialMentionCandidates,
  stagedMaterialOf,
  type MaterialMentionCandidate,
} from '@/lib/workbench/material-mention';
import { MAX_COMPOSER_MATERIALS } from '@/lib/workbench/material-upload-scheduling';
import { useWorkbenchStore, type WorkbenchMaterial } from '@/lib/workbench/session-store';

const listing = (id: string, extra: Record<string, unknown> = {}) => ({
  materialId: id,
  name: `${id}.pdf`,
  bytes: 3,
  mime: 'application/pdf',
  folderId: null,
  extraction: { status: 'done' },
  ...extra,
});

// jsdom lays nothing out; the menu scrolls its highlighted row into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/** Record what a harness's hook returned, outside the component. */
function recorder<T>(sink: { current: T }) {
  return (value: T): T => {
    sink.current = value;
    return value;
  };
}

/** Let the debounce and the fetch settle, with React's updates flushed. */
const settle = (milliseconds = 300) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: (element: ReturnType<typeof createElement>) =>
      act(async () => {
        root.render(element);
      }),
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('material mention candidates', () => {
  it('maps the library listing to rows, marking attached and staged ones', () => {
    const rows = materialMentionCandidates(
      [
        listing('a', { attached: true, folderName: 'Unit 1' }),
        listing('b', { extraction: { status: 'running' } }),
        listing('c', { extraction: undefined }),
      ],
      new Set(['b']),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        materialId: 'a',
        attached: true,
        staged: false,
        folderName: 'Unit 1',
      }),
      expect.objectContaining({
        materialId: 'b',
        attached: false,
        staged: true,
        extractionStatus: 'running',
      }),
      expect.objectContaining({ materialId: 'c', extractionStatus: 'idle' }),
    ]);
    expect(stagedMaterialOf(rows[0]!)).toEqual({
      materialId: 'a',
      name: 'a.pdf',
      bytes: 3,
      mimeType: 'application/pdf',
      extractionStatus: 'done',
    });
    const many = Array.from({ length: MATERIAL_MENTION_LIMIT + 5 }, (_, i) => listing(`m${i}`));
    expect(materialMentionCandidates(many, new Set())).toHaveLength(MATERIAL_MENTION_LIMIT);
  });
});

describe('staging a picked material', () => {
  it('settles a send under StrictMode without losing later slot reservations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ enabled: true })),
    );
    const sink: { current: ComposerMaterials | null } = { current: null };
    const record = recorder(sink);
    function Harness() {
      record(useComposerMaterials());
      return null;
    }
    const mounted = mount();
    await mounted.render(createElement(StrictMode, null, createElement(Harness)));
    await act(async () => {
      await vi.waitFor(() => expect(sink.current?.enabled).toBe(true));
    });
    const material = (id: string): WorkbenchMaterial => ({ materialId: id, name: id, bytes: 1 });
    await act(async () => sink.current!.addExisting(material('sent')));
    const sent = sink.current!.materials;
    await act(async () => {
      sink.current!.addExisting(material('late-a'));
      sink.current!.removeSent(sent);
      sink.current!.addExisting(material('late-b'));
    });
    expect(sink.current!.materials.map((m) => m.materialId)).toEqual(['late-a', 'late-b']);
    for (let index = 0; index < MAX_COMPOSER_MATERIALS; index += 1) {
      await act(async () => sink.current!.addExisting(material(`next-${index}`)));
    }
    expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
    expect(sink.current!.materials.at(-1)?.materialId).toBe(`next-${MAX_COMPOSER_MATERIALS - 3}`);
    await mounted.dispose();
  });

  it.each(['double pick', 'remove and repick', 'old send settlement'] as const)(
    'tracks same-turn picks by current object: %s',
    async (scenario) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ enabled: true })),
      );
      const sink: { current: ComposerMaterials | null } = { current: null };
      const record = recorder(sink);
      function Harness() {
        record(useComposerMaterials());
        return null;
      }
      const mounted = mount();
      await mounted.render(createElement(StrictMode, null, createElement(Harness)));
      await act(async () => {
        await vi.waitFor(() => expect(sink.current?.enabled).toBe(true));
      });
      const material = (id: string): WorkbenchMaterial => ({ materialId: id, name: id, bytes: 1 });
      const original = material('same');
      const repicked = { ...original, name: 'Later pick' };
      await act(async () => {
        sink.current!.addExisting(original);
        if (scenario === 'double pick') sink.current!.addExisting(material('same'));
      });
      const sent = sink.current!.materials;
      if (scenario !== 'double pick') {
        await act(async () => {
          sink.current!.remove('same');
          sink.current!.addExisting(repicked);
          if (scenario === 'old send settlement') {
            sink.current!.removeSent(sent);
            sink.current!.removeSent(sent);
          }
          sink.current!.addExisting(material('same'));
        });
      }
      expect(sink.current!.materials).toEqual([scenario === 'double pick' ? original : repicked]);
      expect(sink.current!.materials[0]).toBe(scenario === 'double pick' ? original : repicked);
      await act(async () => {
        for (let index = 0; index < MAX_COMPOSER_MATERIALS; index += 1) {
          sink.current!.addExisting(material(`fill-${index}`));
        }
      });
      expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
      expect(sink.current!.materials.at(-1)?.materialId).toBe(`fill-${MAX_COMPOSER_MATERIALS - 2}`);
      await mounted.dispose();
    },
  );

  it('allows repicking after clear while preserving a pending upload reservation', async () => {
    let resolveUpload!: (response: Response) => void;
    let started = false;
    const response = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/agent/runtime') return Response.json({ enabled: true });
        if (String(input) === '/api/materials') {
          started = true;
          return response;
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      }),
    );
    const sink: { current: ComposerMaterials | null } = { current: null };
    const record = recorder(sink);
    function Harness() {
      record(useComposerMaterials());
      return null;
    }
    const mounted = mount();
    try {
      await mounted.render(createElement(StrictMode, null, createElement(Harness)));
      await act(async () => {
        await vi.waitFor(() => expect(sink.current?.enabled).toBe(true));
      });
      const original: WorkbenchMaterial = { materialId: 'same', name: 'original', bytes: 1 };
      const repicked = { ...original, name: 'repicked' };
      await act(async () => {
        sink.current!.addExisting(original);
        sink.current!.addFiles([new File(['pdf'], 'late.pdf', { type: 'application/pdf' })]);
      });
      await vi.waitFor(() => expect(started).toBe(true));
      await act(async () => sink.current!.clear());
      expect(sink.current!.materials).toEqual([]);
      expect(sink.current!.uploading).toHaveLength(1);
      await act(async () => sink.current!.addExisting(repicked));
      expect(sink.current!.materials).toEqual([repicked]);
      expect(sink.current!.materials[0]).toBe(repicked);
      await act(async () => {
        for (let i = 0; i < MAX_COMPOSER_MATERIALS; i++)
          sink.current!.addExisting({ materialId: `after-clear-${i}`, name: 'fill', bytes: 1 });
      });
      // The in-flight upload still owns one slot after clearing completed picks.
      expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS - 1);
      expect(sink.current!.materials.at(-1)?.materialId).toBe(
        `after-clear-${MAX_COMPOSER_MATERIALS - 3}`,
      );
      await act(async () => {
        resolveUpload(Response.json({ materialId: 'late-upload', originalName: 'late', bytes: 3 }));
        await response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(sink.current!.uploading).toHaveLength(0);
      expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
      expect(sink.current!.materials.at(-1)?.materialId).toBe('late-upload');
      await act(async () => {
        sink.current!.addExisting({ materialId: 'late-upload', name: 'duplicate', bytes: 3 });
      });
      expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
    } finally {
      await mounted.dispose();
    }
  });

  it.each(['removeSent', 'remove'] as const)(
    'releases both objects when a library pick precedes its upload response: %s',
    async (cleanup) => {
      let resolveUpload!: (response: Response) => void;
      let started = false;
      const response = new Promise<Response>((resolve) => {
        resolveUpload = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/agent/runtime') return Response.json({ enabled: true });
          if (String(input) === '/api/materials') {
            started = true;
            return response;
          }
          throw new Error(`unexpected fetch ${String(input)}`);
        }),
      );
      const sink: { current: ComposerMaterials | null } = { current: null };
      const record = recorder(sink);
      function Harness() {
        record(useComposerMaterials());
        return null;
      }
      const mounted = mount();
      await mounted.render(createElement(StrictMode, null, createElement(Harness)));
      await act(async () => {
        await vi.waitFor(() => expect(sink.current?.enabled).toBe(true));
      });
      await act(async () => {
        sink.current!.addFiles([new File(['pdf'], 'delayed.pdf', { type: 'application/pdf' })]);
      });
      await vi.waitFor(() => expect(started).toBe(true));
      await act(async () =>
        sink.current!.addExisting({ materialId: 'same-upload', name: 'library copy', bytes: 3 }),
      );
      await act(async () => {
        resolveUpload(
          Response.json({ materialId: 'same-upload', originalName: 'upload copy', bytes: 3 }),
        );
        await response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(sink.current!.materials.map((m) => m.materialId)).toEqual([
        'same-upload',
        'same-upload',
      ]);
      const sent = sink.current!.materials;
      await act(async () => {
        if (cleanup === 'removeSent') sink.current!.removeSent(sent);
        else sink.current!.remove('same-upload');
      });
      expect(sink.current!.materials).toEqual([]);
      await act(async () => {
        for (let i = 0; i < MAX_COMPOSER_MATERIALS; i++)
          sink.current!.addExisting({
            materialId: `after-upload-${i}`,
            name: `after-upload-${i}`,
            bytes: 1,
          });
      });
      const count = sink.current!.materials.length;
      await mounted.dispose();
      expect(count).toBe(MAX_COMPOSER_MATERIALS);
    },
  );

  it('stages once, attaches nothing, and keeps the per-message cap', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/agent/runtime')) return Response.json({ enabled: true });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const sink: { current: ComposerMaterials | null } = { current: null };
    const record = recorder(sink);
    function Harness() {
      record(useComposerMaterials());
      return null;
    }
    const mounted = mount();
    await mounted.render(createElement(Harness));
    await act(async () => {
      await vi.waitFor(() => expect(sink.current?.enabled).toBe(true));
    });
    const material = (id: string): WorkbenchMaterial => ({ materialId: id, name: id, bytes: 1 });
    await act(async () => {
      sink.current!.addExisting(material('a'));
    });
    await act(async () => {
      sink.current!.addExisting(material('a'));
    });
    expect(sink.current!.materials.map((m) => m.materialId)).toEqual(['a']);
    for (let index = 1; index < MAX_COMPOSER_MATERIALS + 2; index += 1) {
      await act(async () => {
        sink.current!.addExisting(material(`m${index}`));
      });
    }
    expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
    // Removing a pill frees its slot.
    await act(async () => {
      sink.current!.remove('a');
    });
    await act(async () => {
      sink.current!.addExisting(material('late'));
    });
    expect(sink.current!.materials.at(-1)?.materialId).toBe('late');
    // A send settles its snapshot, preserving a removed-and-repicked id and
    // releasing exactly the accepted slots, even if settlement is replayed.
    const sent = sink.current!.materials;
    await act(async () => sink.current!.remove('late'));
    await act(async () => sink.current!.addExisting(material('late')));
    await act(async () => sink.current!.removeSent(sent));
    await act(async () => sink.current!.removeSent(sent));
    expect(sink.current!.materials.map((m) => m.materialId)).toEqual(['late']);
    for (let index = 0; index < MAX_COMPOSER_MATERIALS + 1; index += 1) {
      await act(async () => sink.current!.addExisting(material(`after-${index}`)));
    }
    expect(sink.current!.materials).toHaveLength(MAX_COMPOSER_MATERIALS);
    // Nothing but the runtime probe was fetched: staging is not attaching.
    expect(
      fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url !== '/api/agent/runtime'),
    ).toEqual([]);
    await mounted.dispose();
  });
});

describe('listing for the menu', () => {
  it.each(['query', 'session'] as const)(
    'does not offer or select the previous listing after a %s change',
    async (changed) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ materials: [listing('unrelated', { attached: true })] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const picked: string[] = [];
      const sink: { current: MaterialMentionCandidate[] | undefined } = { current: undefined };
      const record = recorder(sink);
      function Harness(props: { query: string; sessionId: string }) {
        const materials = record(
          useMaterialMentions({
            ...props,
            open: true,
            enabled: true,
            staged: [],
          }),
        );
        return createElement(
          'div',
          null,
          createElement(CourseMentionMenu, {
            candidates: [],
            materials,
            onPick: () => undefined,
            onClose: () => undefined,
            onPickMaterial: (material) => picked.push(material.materialId),
          }),
          createElement('textarea'),
        );
      }
      const mounted = mount();
      try {
        await mounted.render(createElement(Harness, { query: '', sessionId: 'ses-1' }));
        await settle();
        expect(sink.current?.[0]).toMatchObject({ materialId: 'unrelated', attached: true });
        fetchMock.mockImplementation(async () =>
          Response.json({ materials: [listing('report', { attached: false })] }),
        );
        await mounted.render(
          createElement(Harness, {
            query: changed === 'query' ? 'report' : '',
            sessionId: changed === 'session' ? 'ses-2' : 'ses-1',
          }),
        );
        expect(sink.current).toEqual([]);
        await act(async () => {
          mounted.container
            .querySelector('textarea')!
            .dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            );
        });
        expect(picked).toEqual([]);
        await settle();
        expect(sink.current?.[0]).toMatchObject({ materialId: 'report', attached: false });
        await act(async () => {
          mounted.container
            .querySelector('textarea')!
            .dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            );
        });
        expect(picked).toEqual(['report']);
      } finally {
        await mounted.dispose();
      }
    },
  );

  it('fetches sources for the query and conversation while open, and again on a library change', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return Response.json({ materials: [listing('a', { attached: true })] });
      }),
    );
    const sink: { current: MaterialMentionCandidate[] | undefined } = { current: undefined };
    const record = recorder(sink);
    function Harness(props: { open: boolean; query: string }) {
      record(
        useMaterialMentions({
          open: props.open,
          enabled: true,
          query: props.query,
          sessionId: 'ses-1',
          staged: [{ materialId: 'a', name: 'a', bytes: 1 }],
        }),
      );
      return null;
    }
    const mounted = mount();
    await mounted.render(createElement(Harness, { open: false, query: '' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(urls).toEqual([]);

    await mounted.render(createElement(Harness, { open: true, query: 'cell' }));
    await settle();
    expect(sink.current).toHaveLength(1);
    expect(urls).toEqual([
      '/api/materials/library?sources=1&limit=20&limits=0&query=cell&sessionId=ses-1',
    ]);
    expect(sink.current![0]).toMatchObject({ attached: true, staged: true });

    // A material change of this run refetches.
    await act(async () => {
      useWorkbenchStore.setState({
        materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
      });
    });
    await settle();
    expect(urls).toHaveLength(2);
    await mounted.dispose();
  });

  it('offers nothing, and fetches nothing, while materials are disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sink: { current: MaterialMentionCandidate[] | undefined | null } = { current: null };
    const record = recorder(sink);
    function Harness() {
      record(
        useMaterialMentions({
          open: true,
          enabled: false,
          query: '',
          sessionId: null,
          staged: [],
        }),
      );
      return null;
    }
    const mounted = mount();
    await mounted.render(createElement(Harness));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sink.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await mounted.dispose();
  });
});

describe('the @ menu with the knowledge base', () => {
  const course = {
    stageId: 'stage-1',
    title: 'Cells',
    reason: 'recent' as const,
    alreadyReferenced: false,
  };
  const material = (
    id: string,
    extra: Partial<MaterialMentionCandidate> = {},
  ): MaterialMentionCandidate => ({
    materialId: id,
    name: `${id}.pdf`,
    bytes: 3,
    extractionStatus: 'done',
    attached: false,
    staged: false,
    ...extra,
  });

  async function renderMenu(props: {
    materials?: MaterialMentionCandidate[];
    onPick?: () => void;
    onPickMaterial?: (candidate: MaterialMentionCandidate) => void;
  }) {
    const mounted = mount();
    await mounted.render(
      createElement(
        'div',
        null,
        createElement(CourseMentionMenu, {
          candidates: [course],
          onPick: props.onPick ?? (() => undefined),
          onClose: () => undefined,
          ...(props.materials ? { materials: props.materials } : {}),
          ...(props.onPickMaterial ? { onPickMaterial: props.onPickMaterial } : {}),
        }),
        createElement('textarea', { 'data-testid': 'composer' }),
      ),
    );
    return mounted;
  }

  const press = (target: Element, key: string) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

  it('lists classrooms, then the knowledge base with folder and state', async () => {
    const mounted = await renderMenu({
      materials: [
        material('a', { folderName: 'Unit 1', attached: true }),
        material('b', { extractionStatus: 'running', staged: true }),
      ],
      onPickMaterial: () => undefined,
    });
    const text = mounted.container.textContent ?? '';
    expect(text.indexOf('workspace.courseMention.classrooms')).toBeLessThan(
      text.indexOf('workspace.courseMention.knowledgeBase'),
    );
    const a = mounted.container.querySelector('[data-testid="workbench-material-option-a"]')!;
    expect(a.textContent).toContain('Unit 1');
    expect(
      a.querySelector('[aria-label="workspace.courseMention.materialAttached"]'),
    ).not.toBeNull();
    const b = mounted.container.querySelector('[data-testid="workbench-material-option-b"]')!;
    // At the top level: the state alone, no folder word and no stray separator.
    expect(b.textContent).toContain('workspace.courseMention.materialExtracting');
    expect(b.textContent).not.toContain('·');
    expect(b.textContent).not.toMatch(/unfiled/i);
    expect(a.textContent).toContain('Unit 1 · workspace.courseMention.materialExtracted');
    expect(b.querySelector('[aria-label="workspace.courseMention.materialStaged"]')).not.toBeNull();
    await mounted.dispose();
  });

  it('walks both sections with the keyboard and picks a material with Enter', async () => {
    const picked: string[] = [];
    const onPick = vi.fn();
    const mounted = await renderMenu({
      materials: [material('a'), material('b')],
      onPick,
      onPickMaterial: (candidate) => picked.push(candidate.materialId),
    });
    const textarea = mounted.container.querySelector('textarea')!;
    await press(textarea, 'ArrowDown');
    await press(textarea, 'ArrowDown');
    await press(textarea, 'Enter');
    expect(picked).toEqual(['b']);
    expect(onPick).not.toHaveBeenCalled();
    // Up from the last row: the first material.
    await press(textarea, 'ArrowUp');
    await press(textarea, 'Enter');
    expect(picked).toEqual(['b', 'a']);
    // Up past the classroom wraps around to the last material.
    await press(textarea, 'ArrowUp');
    await press(textarea, 'ArrowUp');
    await press(textarea, 'Enter');
    expect(picked).toEqual(['b', 'a', 'b']);
    await mounted.dispose();
  });

  it('is the classroom picker alone when the knowledge base is not offered', async () => {
    const mounted = await renderMenu({});
    expect(
      mounted.container.querySelector('[data-testid="workbench-material-section"]'),
    ).toBeNull();
    expect(mounted.container.textContent).toContain('workspace.courseMention.courseOrder');
    await mounted.dispose();
  });
});
