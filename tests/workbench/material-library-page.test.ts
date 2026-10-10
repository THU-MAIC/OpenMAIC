// @vitest-environment jsdom
/**
 * The knowledge base page as one file-manager list (RFC #1716 §1, §7, §8;
 * #1835 review): what it reads and shows, the inline new folder, the folder
 * rows, uploads, organizing, deleting and the hand-over to a conversation.
 * The tree's own paging and refresh rules are `material-library-tree.test.ts`;
 * these are the page on top of them.
 */
import { MATERIAL_EXTRACTION_REASON_CODES } from '@/lib/types/material-extraction-failure';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const parseToast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: parseToast }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}${JSON.stringify(values)}` : key,
  }),
}));

import {
  formatLibraryDate,
  MaterialLibraryPage,
} from '@/components/workbench/workspace/MaterialLibraryPage';
import { MATERIAL_LIBRARY_TREE_POLL_MS } from '@/lib/workbench/use-material-library-tree';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { deleteOutcomeOf } from '@/components/workbench/workspace/MaterialLibraryDialogs';
import {
  createLibraryFolder,
  fetchMaterialLibraryFolders,
  formatMaterialBytes,
  MaterialLibraryRequestError,
  materialLibraryErrorOf,
} from '@/lib/workbench/material-library-client';

const LIMITS = {
  documentMaxBytes: 50 * 1024 * 1024,
  mediaMaxBytes: 50 * 1024 * 1024,
  maxCount: 100,
  maxTotalBytes: 2 * 1024 ** 3,
  usedCount: 3,
  usedBytes: 2048,
  assetQuotaBytes: 10 * 1024 ** 3,
  assetUsedBytes: 4096,
};

const source = (id: string, extra: Record<string, unknown> = {}) => ({
  materialId: id,
  kind: 'source',
  name: `${id}.pdf`,
  mime: 'application/pdf',
  bytes: 1024,
  folderId: null,
  extraction: { status: 'done' },
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});
const inF1 = (id: string, extra: Record<string, unknown> = {}) =>
  source(id, { folderId: 'f1', folderName: 'Unit 1', ...extra });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type LibraryHandler = (params: URLSearchParams) => Promise<Response> | Response;

let library: LibraryHandler;
let folders: () => Promise<Response> | Response;
const libraryCalls: URLSearchParams[] = [];
let uploadMaterial: (file: File) => Promise<Response> | Response;
const uploadCalls: { url: string; init: RequestInit }[] = [];
interface WriteCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
let writeMaterial: (call: WriteCall) => Promise<Response> | Response;
const writeCalls: WriteCall[] = [];
let folderReads = 0;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const method = init?.method ?? 'GET';
      const organizing =
        url.pathname.endsWith('/extraction') ||
        method === 'PATCH' ||
        method === 'DELETE' ||
        url.pathname === '/api/materials/move' ||
        (url.pathname === '/api/materials/folders' && method === 'POST');
      if (organizing) {
        const call = {
          method,
          path: url.pathname,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        writeCalls.push(call);
        return writeMaterial(call);
      }
      if (url.pathname === '/api/materials/folders') {
        folderReads += 1;
        return folders();
      }
      if (url.pathname === '/api/materials' && init?.method === 'POST') {
        uploadCalls.push({ url: input, init });
        return uploadMaterial(init.body as File);
      }
      if (url.pathname === '/api/materials/library') {
        libraryCalls.push(url.searchParams);
        return library(url.searchParams);
      }
      throw new Error(`unexpected fetch ${input}`);
    }),
  );
}

/** Let answers land: reading a response body takes several macrotasks in jsdom. */
const settle = (milliseconds = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

/** Mounted roots still alive; `afterEach` unmounts any a failed test left. */
const mounted = new Set<() => Promise<void>>();

const props = (extra: Record<string, unknown> = {}) => ({
  onChatWithMaterial: () => {},
  onLeave: () => {},
  ...extra,
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const dispose = async () => {
    if (!mounted.delete(dispose)) return;
    await act(async () => root.unmount());
    container.remove();
  };
  mounted.add(dispose);
  return {
    container,
    query: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    render: (element: ReturnType<typeof createElement>) => act(async () => root.render(element)),
    click: (testId: string) =>
      act(async () => {
        container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
      }),
    dispose,
  };
}
async function openPage(extra: Record<string, unknown> = {}) {
  const page = mount();
  await page.render(createElement(MaterialLibraryPage, props(extra)));
  await settle();
  return page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const inDocument = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const openMenu = async (testId: string) => {
  const trigger = inDocument(testId)!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
    trigger.click();
  });
};
const choose = (testId: string) =>
  act(async () => {
    inDocument(testId)!.click();
  });
const typeInto = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
/** A key pressed in an element; `keyCode` too, as an input method's Enter carries 229. */
const press = (
  element: Element,
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
) =>
  act(async () => {
    const { keyCode, ...rest } = init;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
    if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
    element.dispatchEvent(event);
  });
const renameInput = () => inDocument('kb-rename-input') as HTMLInputElement | null;
/** Rename from a ⋯ menu: the field opens once the menu has closed. */
const renameFrom = async (menuId: string) => {
  await openMenu(menuId);
  await choose(`${menuId}-rename`);
  await settle();
};
const search = async (value: string) => {
  await typeInto(inDocument('kb-search') as HTMLInputElement, value);
  await settle(350);
};
const expand = async (folderId: string) => {
  await choose(`kb-folder-toggle-${folderId}`);
  await settle();
};

beforeEach(() => {
  parseToast.error.mockClear();
  libraryCalls.length = 0;
  uploadCalls.length = 0;
  writeCalls.length = 0;
  folderReads = 0;
  writeMaterial = ({ path }) =>
    path === '/api/materials/folders'
      ? json({ folder: { id: 'f-new', name: 'New' }, created: true }, 201)
      : json({ status: 'renamed' });
  uploadMaterial = (file) =>
    json(
      {
        materialId: `stored-${file.name}`,
        originalName: file.name,
        bytes: file.size,
        mime: file.type,
        extraction: { status: 'idle' },
      },
      201,
    );
  library = (params) => {
    const folderId = params.get('folderId');
    return json({
      materials:
        folderId === 'f1'
          ? [inF1('in-f1')]
          : folderId && folderId !== 'unfiled'
            ? []
            : [source('a')],
      ...(params.get('limits') === '0' ? {} : { limits: LIMITS }),
    });
  };
  folders = () =>
    json({
      folders: [
        { id: 'f1', name: 'Unit 1', materialCount: 2, createdAt: 1, updatedAt: 1 },
        { id: 'f2', name: 'Unit 2', materialCount: 0, createdAt: 1, updatedAt: 1 },
      ],
    });
  stubFetch();
});

afterEach(async () => {
  for (const dispose of [...mounted]) await dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Reading and showing ────────────────────────────────────────────────────

describe('the list', () => {
  it('reads the folders and the files in no folder; a folder’s files only once expanded', async () => {
    const page = await openPage();
    expect(libraryCalls.map((params) => params.get('folderId'))).toEqual(['unfiled']);
    expect(libraryCalls[0]!.get('sources')).toBe('1');
    expect(libraryCalls[0]!.get('limit')).toBe('200');
    expect(libraryCalls[0]!.has('limits')).toBe(false);

    // Folders first, then the files in no folder.
    const rows = [
      ...page.container.querySelectorAll(
        '[data-testid^="kb-folder-"], [data-testid^="kb-material-"]',
      ),
    ]
      .map((row) => row.getAttribute('data-testid'))
      .filter((id) => id === 'kb-folder-f1' || id === 'kb-folder-f2' || id === 'kb-material-a');
    expect(rows).toEqual(['kb-folder-f1', 'kb-folder-f2', 'kb-material-a']);
    // The count is in the Size column ("N items"), not after the name.
    expect(page.query('kb-folder-items-f1')?.textContent).toBe(
      'workspace.knowledgeBase.folder.items{"count":2}',
    );
    expect(page.query('kb-folder-toggle-f1')?.textContent).not.toContain('(2)');
    expect(page.query('kb-folder-toggle-f1')?.getAttribute('aria-expanded')).toBe('false');
    expect(page.query('kb-material-in-f1')).toBeNull();

    await expand('f1');
    expect(libraryCalls.at(-1)?.get('folderId')).toBe('f1');
    expect(libraryCalls.at(-1)?.get('limits')).toBe('0');
    expect(page.query('kb-folder-toggle-f1')?.getAttribute('aria-expanded')).toBe('true');
    expect(page.query('kb-folder-files-f1')?.contains(page.query('kb-material-in-f1'))).toBe(true);

    await expand('f1');
    expect(page.query('kb-material-in-f1')).toBeNull();
    // An empty folder says so when opened.
    await expand('f2');
    expect(page.query('kb-folder-empty-f2')?.textContent).toBe(
      'workspace.knowledgeBase.empty.folder',
    );
    await page.dispose();
  });

  it('searches as one flat list with each file’s folder, and is back to the tree once cleared', async () => {
    library = (params) =>
      params.get('query')
        ? json({ materials: [inF1('hit'), source('loose')], limits: LIMITS })
        : json({ materials: [source('a')], limits: LIMITS });
    const page = await openPage();
    await expand('f1');
    await search('  photosynthesis ');
    const asked = libraryCalls.at(-1)!;
    expect(asked.get('query')).toBe('photosynthesis');
    expect(asked.get('folderId')).toBeNull();
    expect(page.query('kb-tree')).toBeNull();
    expect(page.query('kb-material-hit')?.textContent).toContain('Unit 1');
    // A top-level file names no folder, under any word.
    const loose = page.query('kb-material-loose')!.textContent ?? '';
    expect(loose).not.toContain('Unit 1');
    expect(loose).not.toMatch(/unfiled/i);

    // Clearing goes back at once, with the folder still open.
    await typeInto(inDocument('kb-search') as HTMLInputElement, '');
    await settle();
    expect(page.query('kb-tree')).not.toBeNull();
    expect(page.query('kb-folder-toggle-f1')?.getAttribute('aria-expanded')).toBe('true');
    await page.dispose();
  });

  it('never lets a slow answer for an earlier query paint over a newer one', async () => {
    const slow = deferred<Response>();
    library = (params) =>
      params.get('query') === 'old'
        ? slow.promise
        : json({ materials: [source(params.get('query') ?? 'all')], limits: LIMITS });
    const page = await openPage();
    await search('old');
    await search('new');
    expect(page.query('kb-material-new')).not.toBeNull();
    await act(async () => slow.resolve(json({ materials: [source('old')], limits: LIMITS })));
    await settle();
    expect(page.query('kb-material-old')).toBeNull();
    expect(page.query('kb-material-new')).not.toBeNull();
    await page.dispose();
  });

  it('names every processing state; a parse shows a turning mark; a failure only that it failed', async () => {
    library = () =>
      json({
        materials: [
          source('idle', { extraction: { status: 'idle' } }),
          source('pending', { extraction: { status: 'pending' } }),
          source('running', { extraction: { status: 'running' } }),
          source('done'),
          source('failed', {
            extraction: { status: 'failed', reason: 'MinerU base URL is required' },
          }),
        ],
        limits: LIMITS,
      });
    const page = await openPage();
    const status = (id: string) => page.query(`kb-status-${id}`)?.textContent;
    expect(status('idle')).toBe('workspace.knowledgeBase.status.stored');
    expect(status('pending')).toBe('workspace.knowledgeBase.status.parsing');
    expect(status('running')).toBe('workspace.knowledgeBase.status.parsing');
    expect(status('done')).toBe('workspace.knowledgeBase.status.searchable');
    expect(status('failed')).toBe('workspace.knowledgeBase.status.failed');
    expect(page.query('kb-status-running-spinner')).not.toBeNull();
    expect(page.query('kb-status-done-spinner')).toBeNull();
    // The backend's own text is not shown in the row.
    expect(page.container.textContent).not.toContain('MinerU');
    await page.dispose();
  });

  it('shows the usage as one bar with the file count, the per-file limits on the upload, no pool quota', async () => {
    const page = await openPage();
    const bar = page.query('kb-usage-bar')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe(String(LIMITS.usedBytes));
    expect(bar.getAttribute('aria-valuemax')).toBe(String(LIMITS.maxTotalBytes));
    // One group: the bytes and the file count in one line, the short bar beside it.
    expect(page.query('kb-usage-summary')?.textContent).toBe(
      'workspace.knowledgeBase.usage.summary{"used":"2 KB","max":"2 GB","count":3,"maxCount":100}',
    );
    expect(page.query('kb-usage')!.contains(bar)).toBe(true);
    expect(bar.getAttribute('aria-label')).toBe(page.query('kb-usage-summary')?.textContent);
    // The upload button is described by the per-file limits, written out
    // where there is no hover.
    const upload = page.query('kb-upload')!;
    const describedBy = upload.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'workspace.knowledgeBase.limits.perFile{"document":"50 MB","media":"50 MB"}',
    );
    expect(page.query('kb-upload-limits')?.className).toContain('md:hidden');
    // The pool quota stays off the page.
    expect(page.container.textContent).not.toContain('10 GB');
    expect(page.container.textContent).not.toContain('4 KB');
    await page.dispose();
  });

  it('says what the knowledge base is for only when it holds nothing, and not while uploading', async () => {
    library = () => json({ materials: [], limits: LIMITS });
    folders = () => json({ folders: [] });
    const stored = deferred<Response>();
    uploadMaterial = () => stored.promise;
    const page = await openPage();
    expect(page.query('kb-onboarding')?.textContent).toContain(
      'workspace.knowledgeBase.empty.body',
    );

    const input = page.query('kb-upload-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['%PDF'], 'first.pdf', { type: 'application/pdf' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(page.query('kb-onboarding')).toBeNull();
    expect(page.query('kb-upload-1')?.textContent).toContain(
      'workspace.knowledgeBase.status.uploading',
    );
    await act(async () => stored.resolve(json({ materialId: 'm1' }, 201)));
    await settle();

    // With folders, an empty top level is not an empty knowledge base.
    folders = () => json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 0 }] });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(page.query('kb-onboarding')).toBeNull();
    await page.dispose();
  });

  it('reports a failed read as an error, never as an empty library, and retries', async () => {
    library = () =>
      json({ success: false, errorCode: 'INTERNAL_ERROR', error: 'boom', reason: 'x' }, 500);
    const page = await openPage();
    expect(page.query('kb-error')?.textContent).toContain('workspace.knowledgeBase.error.load');
    expect(page.query('kb-onboarding')).toBeNull();

    library = () => json({ materials: [source('a')], limits: LIMITS });
    await page.click('kb-retry');
    await settle();
    expect(page.query('kb-error')).toBeNull();
    expect(page.query('kb-material-a')).not.toBeNull();
    await page.dispose();
  });

  it('keeps what is shown when a later read fails, and says it may be out of date', async () => {
    const page = await openPage();
    library = () => json({ success: false, errorCode: 'X', error: 'x' }, 503);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(page.query('kb-material-a')).not.toBeNull();
    expect(page.query('kb-stale')?.textContent).toContain('workspace.knowledgeBase.error.busy');
    await page.dispose();
  });

  it('pages each node from its own "load more", disabled while a refresh rereads the list', async () => {
    let refreshed = false;
    const reread = deferred<Response>();
    library = (params) => {
      if (params.get('before')) return json({ materials: [source('older')] });
      if (refreshed) return reread.promise;
      return json({ materials: [source('a')], nextBefore: 'a', limits: LIMITS });
    };
    const page = await openPage();
    expect(page.query('kb-load-more')).not.toBeNull();
    refreshed = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect((page.query('kb-load-more') as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      reread.resolve(json({ materials: [source('a')], nextBefore: 'fresh', limits: LIMITS })),
    );
    await settle();
    expect((page.query('kb-load-more') as HTMLButtonElement).disabled).toBe(false);
    await page.click('kb-load-more');
    await settle();
    expect(libraryCalls.at(-1)?.get('before')).toBe('fresh');
    expect(page.query('kb-material-older')).not.toBeNull();
    await page.dispose();
  });
});

// ── Staying fresh (option B) on the page ───────────────────────────────────

describe('staying fresh without moving the teacher', () => {
  it('a background refresh keeps the open folders and the rows already shown', async () => {
    const page = await openPage();
    await expand('f1');
    const row = page.query('kb-material-a');
    const nested = page.query('kb-material-in-f1');
    const toggle = page.query('kb-folder-toggle-f1');
    library = (params) =>
      json({
        materials:
          params.get('folderId') === 'f1' ? [inF1('in-f1')] : [source('new-on-top'), source('a')],
        limits: LIMITS,
      });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(page.query('kb-material-new-on-top')).not.toBeNull();
    // The same elements, not rebuilt: the browser keeps its place on them.
    expect(page.query('kb-material-a')).toBe(row);
    expect(page.query('kb-material-in-f1')).toBe(nested);
    expect(page.query('kb-folder-toggle-f1')).toBe(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await page.dispose();
  });

  it('keeps the visible row through refresh insertions and removals, following the teacher’s scroll', async () => {
    folders = () => json({ folders: [] });
    let ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    library = () => json({ materials: ids.map((id) => source(id)), limits: LIMITS });
    const page = await openPage();
    const main = page.query('pro-workspace-library')!;
    // jsdom has no layout. Supply row geometry from the actual rendered order;
    // Chromium/WebKit acceptance separately exercises the real CSS geometry.
    const geometry = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const rows = [...page.query('kb-tree')!.children];
        const index = rows.indexOf(this);
        return new DOMRect(
          0,
          index < 0 ? 0 : index * 40 - main.scrollTop,
          400,
          index < 0 ? 120 : 40,
        );
      });
    const scroll = (top: number) => {
      main.scrollTop = top;
      main.dispatchEvent(new Event('scroll'));
    };
    const refresh = async () => {
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
      await settle();
    };
    try {
      scroll(60);
      const held = page.query('kb-material-b');
      ids = ['new', ...ids];
      await refresh();
      expect(main.scrollTop).toBe(100);
      expect(page.query('kb-material-b')).toBe(held);
      scroll(140);
      ids = ['newer', ...ids];
      await refresh();
      expect(main.scrollTop).toBe(180);
      ids = ids.slice(2);
      await refresh();
      expect(main.scrollTop).toBe(100);
      scroll(0);
      ids = ['at-top', ...ids];
      await refresh();
      expect(main.scrollTop).toBe(0);
    } finally {
      geometry.mockRestore();
    }
  });

  it('reads again when a run reports a material change, with the same folders open', async () => {
    const page = await openPage();
    await expand('f1');
    const reads = libraryCalls.length;
    await act(async () =>
      useWorkbenchStore.setState({
        materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
      }),
    );
    await settle();
    expect(libraryCalls.length).toBe(reads + 2);
    expect(page.query('kb-folder-toggle-f1')?.getAttribute('aria-expanded')).toBe('true');
    await page.dispose();
  });

  it('keeps polling after a failed read: a failure is not the parse finishing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tick = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });
    library = () =>
      json({ materials: [source('p', { extraction: { status: 'running' } })], limits: LIMITS });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage, props()));
    await tick(0);
    library = () => json({ success: false, errorCode: 'X', error: 'x' }, 500);
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    const failedAt = libraryCalls.length;
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    expect(libraryCalls.length).toBe(failedAt + 1);
    await page.dispose();
  });

  it('does not read the list for a page the teacher left before a write answered', async () => {
    for (const action of ['rename', 'move', 'create'] as const) {
      const answer = deferred<Response>();
      writeMaterial = () => answer.promise;
      writeCalls.length = 0;
      const page = await openPage();
      if (action === 'create') {
        await page.click('kb-folder-new');
        await typeInto(inDocument('kb-new-folder-input') as HTMLInputElement, 'Later');
        await press(inDocument('kb-new-folder-input')!, 'Enter');
      } else if (action === 'rename') {
        await renameFrom('kb-material-menu-a');
        await typeInto(renameInput()!, 'Later');
        await press(renameInput()!, 'Enter');
      } else {
        await openMenu('kb-material-menu-a');
        await choose('kb-material-menu-a-move');
        await choose('kb-move-to-f1');
        await choose('kb-move-confirm');
      }
      expect(writeCalls, action).toHaveLength(1);

      await page.dispose();
      const reads = libraryCalls.length;
      const foldersRead = folderReads;
      await act(async () =>
        answer.resolve(
          action === 'create'
            ? json({ folder: { id: 'f-late', name: 'Later' }, created: true }, 201)
            : json({ status: 'renamed' }),
        ),
      );
      await settle();
      expect(libraryCalls.length, action).toBe(reads);
      expect(folderReads, action).toBe(foldersRead);
    }
  });
});

// ── Leaving ────────────────────────────────────────────────────────────────

describe('the way back', () => {
  it('is in the compact header for narrow screens, and leaves the page', async () => {
    const onLeave = vi.fn();
    const page = await openPage({ onLeave });
    const back = page.query('kb-back')!;
    expect(back.parentElement?.className).toContain('md:hidden');
    await page.click('kb-back');
    expect(onLeave).toHaveBeenCalledTimes(1);
    await page.dispose();
  });
});

// ── Uploading ──────────────────────────────────────────────────────────────

describe('uploading from the page', () => {
  const file = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
  async function chooseFiles(page: ReturnType<typeof mount>, files: File[]) {
    const input = page.query('kb-upload-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('shows the file uploading, then reads the list again once it is stored, into no folder', async () => {
    const stored = deferred<Response>();
    uploadMaterial = () => stored.promise;
    const page = await openPage();
    await expand('f1');
    const reads = libraryCalls.length;

    await chooseFiles(page, [file('lesson.pdf')]);
    await settle();
    expect(page.query('kb-upload-1')?.textContent).toContain('lesson.pdf');
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.url).toBe('/api/materials');
    expect(JSON.stringify(uploadCalls[0]!.init.headers)).not.toMatch(/folder/i);

    await act(async () =>
      stored.resolve(json({ materialId: 'm1', originalName: 'lesson.pdf', bytes: 4 }, 201)),
    );
    await settle();
    expect(page.query('kb-upload-1')).toBeNull();
    // One refresh: the top level and the open folder.
    expect(libraryCalls.length).toBe(reads + 2);
    await page.dispose();
  });

  it('shows an upload parsing, without a Parse click, and follows it to its final state', async () => {
    let state: string | null = null;
    library = () =>
      json({
        materials: state ? [source('m1', { extraction: { status: state } })] : [],
        limits: LIMITS,
      });
    uploadMaterial = () => {
      state = 'pending';
      return json(
        { materialId: 'm1', originalName: 'lesson.pdf', bytes: 4, extraction: { status: state } },
        201,
      );
    };
    const page = await openPage();
    await chooseFiles(page, [file('lesson.pdf')]);
    await settle();
    expect(page.query('kb-status-m1')!.dataset.status).toBe('pending');
    expect(page.query('kb-status-m1')!.textContent).toBe('workspace.knowledgeBase.status.parsing');
    await openMenu('kb-material-menu-m1');
    expect(inDocument('kb-material-menu-m1-parse')).toBeNull();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    state = 'done';
    await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
    expect(page.query('kb-status-m1')!.dataset.status).toBe('done');
    const settled = libraryCalls.length;
    await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
    expect(libraryCalls.length).toBe(settled);
    expect(writeCalls).toEqual([]);
    await page.dispose();
  }, 12000);

  it('says why an upload was refused, with the shared messages, until dismissed', async () => {
    const pool = json(
      { success: false, errorCode: 'ASSET_QUOTA_EXCEEDED', error: 'asset storage quota exceeded' },
      507,
    );
    pool.headers.set('x-request-id', 'trace-507');
    const refusals: Record<string, Response> = {
      'big.pdf': json({ error: 'too large', maxBytes: 50 * 1024 * 1024 }, 413),
      'quota.pdf': json({ error: 'quota' }, 429),
      'odd.pdf': json({ error: 'type' }, 415),
      'full.pdf': pool,
    };
    uploadMaterial = (chosen) => refusals[chosen.name]!;
    const page = await openPage();
    const reads = libraryCalls.length;

    await chooseFiles(page, [
      file('big.pdf'),
      file('quota.pdf'),
      file('odd.pdf'),
      file('full.pdf'),
    ]);
    await settle(60);
    const text = page.query('kb-tree')?.textContent ?? '';
    expect(text).toContain('workbench.material.fileTooLargeWithLimit{"limit":"50"}');
    expect(text).toContain('workbench.material.quotaExceeded');
    expect(text).toContain('workbench.material.unsupportedType');
    // The pool quota is off the page, but hitting it still says so.
    expect(text).toContain('workbench.material.storageFull');
    expect(text).not.toContain('trace-507');
    expect(text).not.toContain('asset storage quota exceeded');
    expect(libraryCalls.length).toBe(reads + 4);

    await page.click('kb-upload-1-dismiss');
    expect(page.query('kb-upload-1')).toBeNull();
    expect(page.query('kb-upload-2')).not.toBeNull();
    await page.dispose();
  });

  it('shows a file the server stored even though its answer failed', async () => {
    let stored = false;
    uploadMaterial = () => {
      stored = true;
      return json({ success: false, errorCode: 'INTERNAL_ERROR', error: 'upload failed' }, 500);
    };
    library = () =>
      json({ materials: stored ? [source('kept', { name: 'kept.pdf' })] : [], limits: LIMITS });
    const page = await openPage();
    await chooseFiles(page, [file('kept.pdf')]);
    await settle(60);
    expect(page.query('kb-material-kept')).not.toBeNull();
    expect(page.query('kb-upload-1')?.textContent).toContain('upload failed');
    await page.dispose();
  });

  it('polls while an upload is in flight, though nothing shown is parsing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stored = deferred<Response>();
    uploadMaterial = () => stored.promise;
    const tick = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage, props()));
    await tick(0);
    await chooseFiles(page, [file('slow.pdf')]);
    const reads = libraryCalls.length;
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    expect(libraryCalls.length).toBe(reads + 1);
    await act(async () =>
      stored.resolve(json({ materialId: 'm1', originalName: 'slow.pdf', bytes: 4 }, 201)),
    );
    await tick(0);
    const settled = libraryCalls.length;
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS * 3);
    expect(libraryCalls.length).toBe(settled);
    await page.dispose();
  });
});

// ── New folder, inline ─────────────────────────────────────────────────────

describe('a new folder, in a row of the list', () => {
  const input = () => inDocument('kb-new-folder-input') as HTMLInputElement;
  const enter = async () => {
    await press(input(), 'Enter');
    await settle();
  };

  it('creates it from a row, then gives the focus to the new folder once it is listed', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    expect(document.activeElement).toBe(input());
    folders = () =>
      json({
        folders: [
          { id: 'f1', name: 'Unit 1', materialCount: 2 },
          { id: 'f-new', name: 'New', materialCount: 0 },
        ],
      });
    await typeInto(input(), '  New ');
    await enter();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/folders', body: { name: 'New' } },
    ]);
    expect(page.query('kb-new-folder-row')).toBeNull();
    expect(document.activeElement).toBe(page.query('kb-folder-toggle-f-new'));
    await page.dispose();
  });

  it('is a folder row among the folders, its default name selected, with no buttons', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    const row = page.query('kb-new-folder-row')!;
    expect(page.query('kb-tree')!.firstElementChild).toBe(row);
    expect(row.querySelector('[data-kb-row]')?.className).toBe(
      page.query('kb-folder-f1')!.querySelector('[data-kb-row]')?.className,
    );
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(input().value).toBe('workspace.knowledgeBase.folder.new');
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, input().value.length]);
    await page.dispose();
  });

  it('numbers the default name when the folders shown already have it', async () => {
    const base = 'workspace.knowledgeBase.folder.new';
    folders = () =>
      json({
        folders: [
          { id: 'n1', name: base.toUpperCase(), materialCount: 0 },
          { id: 'n2', name: `${base} 2`, materialCount: 0 },
        ],
      });
    const page = await openPage();
    await page.click('kb-folder-new');
    expect(input().value).toBe(`${base} 3`);
    await page.dispose();
  });

  it('saves when the teacher clicks elsewhere, without taking the focus back', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Elsewhere');
    const searchBox = page.query('kb-search')!;
    folders = () => json({ folders: [{ id: 'f-new', name: 'Elsewhere', materialCount: 0 }] });
    await act(async () => searchBox.focus());
    await settle();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/folders', body: { name: 'Elsewhere' } },
    ]);
    expect(page.query('kb-new-folder-row')).toBeNull();
    expect(page.query('kb-folder-toggle-f-new')).not.toBeNull();
    expect(document.activeElement).toBe(searchBox);
    await page.dispose();
  });

  it('moves no focus after a blur that left it nowhere (WebKit: a click on a button)', async () => {
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Nowhere');
    await act(async () => input().blur());
    expect(document.activeElement).toBe(document.body);
    folders = () => json({ folders: [{ id: 'f-new', name: 'Nowhere', materialCount: 0 }] });
    answer.resolve(json({ folder: { id: 'f-new' }, created: true }));
    await settle();
    expect(page.query('kb-folder-toggle-f-new')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);

    // A refusal of a blur's attempt keeps the edit, without taking the focus either.
    writeMaterial = () => json({ folder: { id: 'f-new' }, created: false });
    await page.click('kb-folder-new');
    await typeInto(input(), 'Nowhere');
    await act(async () => input().blur());
    await settle();
    expect(page.query('kb-new-folder-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    expect(document.activeElement).toBe(document.body);
    await page.dispose();
  });

  it('keeps editing a taken name, saying so, without pointing at the folder it names', async () => {
    writeMaterial = () => json({ folder: { id: 'f1', name: 'Unit 1' }, created: false }, 200);
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'unit 1');
    await enter();
    expect(page.query('kb-new-folder-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    expect(page.query('kb-new-folder-row')).not.toBeNull();
    expect(input().value).toBe('unit 1');
    expect(document.activeElement).toBe(input());
    expect(page.query('kb-list')!.querySelector('[data-highlighted]')).toBeNull();
    // Typing again clears the message; Enter asks again.
    await typeInto(input(), 'Unit 9');
    expect(page.query('kb-new-folder-error')).toBeNull();
    writeMaterial = () => json({ folder: { id: 'f9', name: 'Unit 9' }, created: true }, 201);
    await enter();
    expect(writeCalls).toHaveLength(2);
    expect(page.query('kb-new-folder-row')).toBeNull();
    await page.dispose();
  });

  it('does not point at a folder of the taken name that a later refresh brings', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Elsewhere');
    const reread = deferred<Response>();
    folders = () => reread.promise;
    writeMaterial = () => json({ folder: { id: 'external' }, created: false });
    await enter();
    await act(async () =>
      reread.resolve(json({ folders: [{ id: 'external', name: 'Elsewhere', materialCount: 0 }] })),
    );
    await settle();
    expect(page.query('kb-folder-toggle-external')).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(page.query('kb-new-folder-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    await page.dispose();
  });

  it('does not start another folder draft while its creation is pending', async () => {
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'First');
    await press(input(), 'Enter');
    expect((page.query('kb-folder-new') as HTMLButtonElement).disabled).toBe(true);
    await page.click('kb-folder-new');
    expect(input().value).toBe('First');
    expect(input().disabled).toBe(true);
    expect(writeCalls).toHaveLength(1);
    answer.resolve(json({ folder: { id: 'f-new' }, created: true }));
    await settle();
    expect((page.query('kb-folder-new') as HTMLButtonElement).disabled).toBe(false);
    await page.click('kb-folder-new');
    await typeInto(input(), 'Second');
    expect(input().value).toBe('Second');
  });

  it('asks once for Enter and the blur that follows it', async () => {
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Once');
    await press(input(), 'Enter');
    await act(async () => page.query('kb-search')!.focus());
    answer.resolve(json({ folder: { id: 'f-once' }, created: true }));
    await settle();
    expect(writeCalls).toHaveLength(1);
    await page.dispose();
  });

  it('leaves the Enter of an input method’s composition to the composition', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), '单元');
    await press(input(), 'Enter', { isComposing: true });
    await press(input(), 'Enter', { keyCode: 229 });
    await settle();
    expect(writeCalls).toEqual([]);
    expect(page.query('kb-new-folder-row')).not.toBeNull();
    await enter();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/folders', body: { name: '单元' } },
    ]);
    await page.dispose();
  });

  it('does not steal search focus when the new folder arrives in a slow refresh', async () => {
    const page = await openPage();
    const reread = deferred<Response>();
    await page.click('kb-folder-new');
    await typeInto(input(), 'New');
    folders = () => reread.promise;
    await enter();
    const searchBox = page.query('kb-search')!;
    searchBox.focus();
    reread.resolve(json({ folders: [{ id: 'f-new', name: 'New', materialCount: 0 }] }));
    await settle();
    expect(page.query('kb-folder-toggle-f-new')).not.toBeNull();
    expect(document.activeElement).toBe(searchBox);
  });

  it('does not revive a reveal after focus moved elsewhere and then returned to the body', async () => {
    const page = await openPage();
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    await page.click('kb-folder-new');
    await typeInto(input(), 'New');
    await press(input(), 'Enter');
    const searchBox = page.query('kb-search')!;
    searchBox.focus();
    searchBox.blur();
    expect(document.activeElement).toBe(document.body);
    folders = () => json({ folders: [{ id: 'f-new', name: 'New', materialCount: 0 }] });
    answer.resolve(json({ folder: { id: 'f-new' }, created: true }));
    await settle();
    expect(page.query('kb-folder-toggle-f-new')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take the focus back for a refusal answered after the teacher moved on', async () => {
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Unit 1');
    await press(input(), 'Enter');
    const searchBox = page.query('kb-search')!;
    searchBox.focus();
    answer.resolve(json({ folder: { id: 'f1' }, created: false }));
    await settle();
    expect(page.query('kb-new-folder-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    expect(document.activeElement).toBe(searchBox);
    expect(input().value).toBe('Unit 1');
    await page.dispose();
  });

  it('keeps the row and its focus through a background refresh', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Half typed');
    const field = input();
    const reads = libraryCalls.length;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(libraryCalls.length).toBeGreaterThan(reads);
    expect(input()).toBe(field);
    expect(field.value).toBe('Half typed');
    expect(document.activeElement).toBe(field);
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('cancels on an empty name and hints at an overlong one before asking the server', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), '一'.repeat(21));
    await enter();
    expect(page.query('kb-new-folder-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.folderNameTooLong',
    );
    await typeInto(input(), '   ');
    await enter();
    expect(page.query('kb-new-folder-row')).toBeNull();
    expect(page.query('kb-new-folder-error')).toBeNull();
    expect(document.activeElement).toBe(page.query('kb-folder-new'));
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('names the folder limit, a vanished item and a busy owner', async () => {
    const answers = [
      json({ success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'limit' }, 409),
      new Response('Not found', { status: 404 }),
      json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503),
    ];
    writeMaterial = () => answers.shift()!;
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Another');
    const shown: (string | null | undefined)[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await enter();
      shown.push(page.query('kb-new-folder-error')?.textContent);
    }
    expect(shown).toEqual([
      'workspace.knowledgeBase.error.folderLimit',
      'workspace.knowledgeBase.error.gone',
      'workspace.knowledgeBase.error.busy',
    ]);
    await page.dispose();
  });

  it('is cancelled by Escape, giving the focus back to "New folder"; the blur after it saves nothing', async () => {
    const page = await openPage();
    await page.click('kb-folder-new');
    await typeInto(input(), 'Not this');
    await press(input(), 'Escape');
    await settle();
    expect(page.query('kb-new-folder-row')).toBeNull();
    expect(document.activeElement).toBe(page.query('kb-folder-new'));
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('leaves a search for the tree, by the teacher’s own hand', async () => {
    const page = await openPage();
    await search('photo');
    expect(page.query('kb-results')).not.toBeNull();
    await page.click('kb-folder-new');
    await settle();
    expect((inDocument('kb-search') as HTMLInputElement).value).toBe('');
    expect(page.query('kb-tree')?.contains(page.query('kb-new-folder-row'))).toBe(true);
    await page.dispose();
  });
});

// ── Folder rows ────────────────────────────────────────────────────────────

describe('a folder row', () => {
  it('keeps its toggle and its ⋯ apart: the menu never expands or collapses it', async () => {
    const page = await openPage();
    const toggle = page.query('kb-folder-toggle-f1')!;
    const menu = page.query('kb-folder-menu-f1')!;
    expect(toggle.contains(menu)).toBe(false);
    await openMenu('kb-folder-menu-f1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    for (const key of ['Enter', ' ']) {
      await act(async () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    expect(libraryCalls.some((params) => params.get('folderId') === 'f1')).toBe(false);
    await page.dispose();
  });

  it('offers Delete for both empty and non-empty folders', async () => {
    const page = await openPage();
    await openMenu('kb-folder-menu-f1');
    expect(inDocument('kb-folder-menu-f1-rename')).not.toBeNull();
    expect(inDocument('kb-folder-menu-f1-delete')).not.toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    await openMenu('kb-folder-menu-f2');
    expect(inDocument('kb-folder-menu-f2-delete')).not.toBeNull();
    await page.dispose();
  });
});

// ── Renaming in place ──────────────────────────────────────────────────────

describe('renaming in place', () => {
  const enter = async () => {
    await press(renameInput()!, 'Enter');
    await settle();
  };

  it('renames a source from its menu, its name selected without the extension, then reads the list again', async () => {
    const page = await openPage();
    const reads = libraryCalls.length;
    await renameFrom('kb-material-menu-a');
    const field = renameInput()!;
    expect(page.query('kb-material-a')!.contains(field)).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('a.pdf');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 1]);
    await typeInto(field, '  Chapter 1  ');
    await enter();
    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/a', body: { name: 'Chapter 1' } },
    ]);
    expect(renameInput()).toBeNull();
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('lets a file take a name another file has: the server decides, the page does not check', async () => {
    library = () => json({ materials: [source('a'), source('b')], limits: LIMITS });
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'b.pdf');
    await enter();
    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/a', body: { name: 'b.pdf' } },
    ]);
    await page.dispose();
  });

  it('renames a folder in its row, its whole name selected', async () => {
    const page = await openPage();
    await renameFrom('kb-folder-menu-f1');
    const field = renameInput()!;
    expect(page.query('kb-folder-f1')!.contains(field)).toBe(true);
    expect(page.query('kb-folder-toggle-f1')).toBeNull();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Unit 1'.length]);
    await typeInto(field, 'Unit 1 · Functions');
    await enter();
    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/folders/f1', body: { name: 'Unit 1 · Functions' } },
    ]);
    expect(document.activeElement).toBe(page.query('kb-folder-toggle-f1'));
    await page.dispose();
  });

  it('keeps a refused folder rename in its row, in the server’s terms, and still re-reads', async () => {
    writeMaterial = () =>
      json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'taken', reason: 'name_taken' },
        409,
      );
    const page = await openPage();
    const reads = libraryCalls.length;
    await renameFrom('kb-folder-menu-f1');
    await typeInto(renameInput()!, 'Unit 2');
    await enter();
    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/folders/f1', body: { name: 'Unit 2' } },
    ]);
    expect(inDocument('kb-rename-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    expect(renameInput()!.value).toBe('Unit 2');
    expect(document.activeElement).toBe(renameInput());
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('hints at an overlong folder name; an empty or unchanged name asks nothing', async () => {
    const page = await openPage();
    await renameFrom('kb-folder-menu-f1');
    await typeInto(renameInput()!, '一'.repeat(21));
    await enter();
    expect(inDocument('kb-rename-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.folderNameTooLong',
    );
    await typeInto(renameInput()!, '   ');
    await enter();
    expect(renameInput()).toBeNull();
    await renameFrom('kb-folder-menu-f1');
    await enter();
    expect(renameInput()).toBeNull();
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('is cancelled by Escape, the focus back on the row; the blur after it saves nothing', async () => {
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'Not this');
    await press(renameInput()!, 'Escape');
    await settle();
    expect(renameInput()).toBeNull();
    expect(document.activeElement).toBe(inDocument('kb-material-menu-a'));
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('saves on a blur, once with the Enter before it, and not during a composition', async () => {
    const answer = deferred<Response>();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, '第一章');
    await press(renameInput()!, 'Enter', { isComposing: true });
    await press(renameInput()!, 'Enter', { keyCode: 229 });
    expect(writeCalls).toEqual([]);
    await press(renameInput()!, 'Enter');
    await act(async () => page.query('kb-search')!.focus());
    answer.resolve(json({ status: 'renamed' }));
    await settle();
    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/a', body: { name: '第一章' } },
    ]);
    // The teacher went to the search: the focus stays there.
    expect(document.activeElement).toBe(page.query('kb-search'));

    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'By blur');
    writeMaterial = () => json({ status: 'renamed' });
    await act(async () => page.query('kb-search')!.focus());
    await settle();
    expect(writeCalls.at(-1)).toEqual({
      method: 'PATCH',
      path: '/api/materials/a',
      body: { name: 'By blur' },
    });
    expect(writeCalls).toHaveLength(2);
    await page.dispose();
  });

  it('does not let an earlier answer close a newer edit or rewrite what it holds', async () => {
    library = () => json({ materials: [source('a'), source('b')], limits: LIMITS });
    const first = deferred<Response>();
    writeMaterial = () => first.promise;
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'Old');
    await press(renameInput()!, 'Enter');
    await renameFrom('kb-material-menu-b');
    await typeInto(renameInput()!, 'Newer');
    await act(async () =>
      first.resolve(
        json(
          { success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'invalid_name' },
          400,
        ),
      ),
    );
    await settle();
    expect(page.query('kb-material-b')!.contains(renameInput())).toBe(true);
    expect(renameInput()!.value).toBe('Newer');
    expect(inDocument('kb-rename-error')).toBeNull();
    // The refusal is still said.
    expect(parseToast.error).toHaveBeenCalledWith('workspace.knowledgeBase.error.invalidName');
    await page.dispose();
  });

  it('keeps the edited row and its focus through a background refresh', async () => {
    const page = await openPage();
    await renameFrom('kb-folder-menu-f1');
    await typeInto(renameInput()!, 'Half');
    const field = renameInput()!;
    const rounds = folderReads;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(folderReads).toBeGreaterThan(rounds);
    expect(renameInput()).toBe(field);
    expect(field.value).toBe('Half');
    expect(document.activeElement).toBe(field);
    await page.dispose();
  });

  it('ends the edit, saying so, when what is renamed was deleted elsewhere', async () => {
    const page = await openPage();
    await renameFrom('kb-folder-menu-f2');
    expect(renameInput()).not.toBeNull();
    folders = () => json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 2 }] });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(renameInput()).toBeNull();
    expect(page.query('kb-folder-f2')).toBeNull();
    expect(parseToast.error).toHaveBeenCalledWith('workspace.knowledgeBase.error.gone');
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  describe('when a run moves the file being renamed between shown lists', () => {
    /** Where each file is; a refresh lists them from here. */
    let place: Record<string, string | null>;
    beforeEach(() => {
      place = { a: null, 'in-f1': 'f1' };
      library = (params) => {
        const folderId = params.get('folderId');
        const here = folderId === 'unfiled' ? null : folderId;
        return json({
          materials: Object.entries(place)
            .filter(([, at]) => at === here)
            .map(([id, at]) =>
              at ? source(id, { folderId: at, folderName: `${at} name` }) : source(id),
            ),
          limits: LIMITS,
        });
      };
    });
    const moveByRun = async (id: string, to: string | null) => {
      place[id] = to;
      await act(async () =>
        useWorkbenchStore.setState({
          materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
        }),
      );
      await settle();
    };
    const keepsDraft = async (id: string, from: string | null, to: string | null) => {
      const page = await openPage();
      await expand('f1');
      await expand('f2');
      await renameFrom(`kb-material-menu-${id}`);
      await typeInto(renameInput()!, 'Half typed new name.pdf');
      await moveByRun(id, to);
      const list = to ? page.query(`kb-folder-files-${to}`)! : page.query('kb-tree')!;
      expect(list.contains(renameInput()), `${from} → ${to}`).toBe(true);
      // What was typed stays, the focus with it, the caret after it: nothing selected to overwrite.
      expect(renameInput()!.value).toBe('Half typed new name.pdf');
      expect(document.activeElement).toBe(renameInput());
      expect([renameInput()!.selectionStart, renameInput()!.selectionEnd]).toEqual([23, 23]);
      expect(writeCalls).toEqual([]);
      await press(renameInput()!, 'Enter');
      await settle();
      expect(writeCalls).toEqual([
        {
          method: 'PATCH',
          path: `/api/materials/${id}`,
          body: { name: 'Half typed new name.pdf' },
        },
      ]);
      await page.dispose();
    };

    it('keeps the draft from the top level into an open folder', async () => {
      await keepsDraft('a', null, 'f1');
    });
    it('keeps the draft out of a folder to the top level', async () => {
      await keepsDraft('in-f1', 'f1', null);
    });
    it('keeps the draft from one open folder to another', async () => {
      await keepsDraft('in-f1', 'f1', 'f2');
    });

    it('keeps the caret where it was, not after the extension', async () => {
      const page = await openPage();
      await expand('f1');
      await renameFrom('kb-material-menu-a');
      await typeInto(renameInput()!, 'Chapter one.pdf');
      await act(async () => {
        renameInput()!.setSelectionRange(7, 7);
        renameInput()!.dispatchEvent(
          new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }),
        );
      });
      await moveByRun('a', 'f1');
      expect(page.query('kb-folder-files-f1')!.contains(renameInput())).toBe(true);
      expect([renameInput()!.selectionStart, renameInput()!.selectionEnd]).toEqual([7, 7]);
      await page.dispose();
    });

    it('keeps the typed name when a rename answered after the move is refused', async () => {
      const answer = deferred<Response>();
      writeMaterial = () => answer.promise;
      const page = await openPage();
      await expand('f1');
      await renameFrom('kb-material-menu-a');
      await typeInto(renameInput()!, 'Refused name.pdf');
      await press(renameInput()!, 'Enter');
      await moveByRun('a', 'f1');
      await act(async () =>
        answer.resolve(
          json(
            { success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'invalid_name' },
            400,
          ),
        ),
      );
      await settle();
      expect(page.query('kb-folder-files-f1')!.contains(renameInput())).toBe(true);
      expect(renameInput()!.value).toBe('Refused name.pdf');
      expect(inDocument('kb-rename-error')?.textContent).toBe(
        'workspace.knowledgeBase.error.invalidName',
      );
      // Asked by Enter: the refusal takes the focus back to the field.
      expect(document.activeElement).toBe(renameInput());
      await page.dispose();
    });

    it('takes no focus, in the new row or on a refusal, for a save the teacher left by a blur', async () => {
      const answer = deferred<Response>();
      writeMaterial = () => answer.promise;
      const page = await openPage();
      await expand('f1');
      await renameFrom('kb-material-menu-a');
      await typeInto(renameInput()!, 'Left by blur.pdf');
      await act(async () => renameInput()!.blur());
      expect(document.activeElement).toBe(document.body);
      expect(writeCalls).toHaveLength(1);
      await moveByRun('a', 'f1');
      expect(page.query('kb-folder-files-f1')!.contains(renameInput())).toBe(true);
      expect(document.activeElement).toBe(document.body);
      await act(async () =>
        answer.resolve(
          json(
            { success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'invalid_name' },
            400,
          ),
        ),
      );
      await settle();
      expect(renameInput()!.value).toBe('Left by blur.pdf');
      expect(inDocument('kb-rename-error')?.textContent).toBe(
        'workspace.knowledgeBase.error.invalidName',
      );
      expect(document.activeElement).toBe(document.body);
      await page.dispose();
    });

    it('takes no focus in the new row for a field the teacher had left', async () => {
      const page = await openPage();
      await expand('f1');
      await renameFrom('kb-material-menu-a');
      // Too long: the blur asks nothing of the server, and the field stays, unfocused.
      await typeInto(renameInput()!, 'x'.repeat(300));
      await act(async () => renameInput()!.blur());
      expect(inDocument('kb-rename-error')?.textContent).toBe(
        'workspace.knowledgeBase.error.invalidName',
      );
      expect(document.activeElement).toBe(document.body);
      await moveByRun('a', 'f1');
      expect(page.query('kb-folder-files-f1')!.contains(renameInput())).toBe(true);
      expect(document.activeElement).toBe(document.body);
      expect(writeCalls).toEqual([]);
      await page.dispose();
    });
  });

  it('ends a file’s edit without calling it gone when the file leaves the list, moved into a closed folder', async () => {
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    expect(renameInput()).not.toBeNull();
    library = (params) =>
      json({
        materials: params.get('folderId') === 'f1' ? [inF1('a'), inF1('in-f1')] : [],
        limits: LIMITS,
      });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(renameInput()).toBeNull();
    expect(page.query('kb-material-a')).toBeNull();
    expect(parseToast.error).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('says a file is gone when its rename is answered 404', async () => {
    writeMaterial = () => new Response('Not found', { status: 404 });
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'Too late');
    await press(renameInput()!, 'Enter');
    await settle();
    expect(inDocument('kb-rename-error')?.textContent).toBe('workspace.knowledgeBase.error.gone');
    await page.dispose();
  });

  it('ends a search result’s edit without a word when the search is left', async () => {
    library = (params) =>
      json({
        materials: params.get('query') ? [inF1('in-f1')] : [source('a')],
        limits: LIMITS,
      });
    writeMaterial = () =>
      json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'invalid_name' },
        400,
      );
    const page = await openPage();
    await search('in');
    await renameFrom('kb-material-menu-in-f1');
    await typeInto(renameInput()!, 'Refused');
    await press(renameInput()!, 'Enter');
    await settle();
    expect(inDocument('kb-rename-error')).not.toBeNull();
    parseToast.error.mockClear();
    await act(async () => {
      const box = inDocument('kb-search') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, '');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(page.query('kb-tree')).not.toBeNull();
    expect(renameInput()).toBeNull();
    expect(parseToast.error).not.toHaveBeenCalled();
    await page.dispose();
  });

  it('renames on a double-click of the name, expanding or collapsing the folder at most once', async () => {
    const page = await openPage();
    const toggle = page.query('kb-folder-toggle-f1')!;
    const name = [...toggle.querySelectorAll('span')].find(
      (span) => span.textContent === 'Unit 1',
    )!;
    // A browser renders between the events of a double-click.
    for (const [type, detail] of [
      ['click', 1],
      ['click', 2],
      ['dblclick', 2],
    ] as const) {
      await act(async () => {
        name.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
      });
      await settle();
    }
    expect(page.query('kb-folder-files-f1')).not.toBeNull();
    expect(libraryCalls.filter((params) => params.get('folderId') === 'f1')).toHaveLength(1);
    const field = renameInput()!;
    expect(page.query('kb-folder-f1')!.contains(field)).toBe(true);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Unit 1'.length]);
    await press(field, 'Escape');
    await settle();
    expect(document.activeElement).toBe(page.query('kb-folder-toggle-f1'));

    const file = [...page.query('kb-material-a')!.querySelectorAll('span')].find(
      (span) => span.textContent === 'a.pdf',
    )!;
    await act(async () => {
      file.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
    await settle();
    expect(page.query('kb-material-a')!.contains(renameInput())).toBe(true);
    expect([renameInput()!.selectionStart, renameInput()!.selectionEnd]).toEqual([0, 1]);
    await page.dispose();
  });
});

// ── Out of a folder, and the rows' columns (#1835 review §2, §3) ──────────

describe('taking a file out of its folder', () => {
  /** f1 holds in-f1 until a move answers; then in-f1 is at the top level. */
  const movable = () => {
    let out = false;
    library = (params) =>
      json({
        materials:
          params.get('folderId') === 'f1'
            ? out
              ? []
              : [inF1('in-f1')]
            : out
              ? [source('a'), source('in-f1')]
              : [source('a')],
        limits: LIMITS,
      });
    return () => {
      out = true;
    };
  };

  it('offers Remove from folder only on a file in a folder, and puts it at the top level', async () => {
    const moveOut = movable();
    writeMaterial = () => {
      moveOut();
      return json({ status: 'moved', movedCount: 1 });
    };
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    expect(inDocument('kb-material-menu-a-remove-from-folder')).toBeNull();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await settle();
    await expand('f1');
    await openMenu('kb-material-menu-in-f1');
    expect(inDocument('kb-material-menu-in-f1-remove-from-folder')?.textContent).toContain(
      'workspace.knowledgeBase.actions.removeFromFolder',
    );
    await choose('kb-material-menu-in-f1-remove-from-folder');
    await settle();
    expect(writeCalls).toEqual([
      {
        method: 'POST',
        path: '/api/materials/move',
        body: { materialIds: ['in-f1'], folderId: null },
      },
    ]);
    expect(page.query('kb-folder-files-f1')?.contains(page.query('kb-material-in-f1'))).toBe(false);
    expect(page.query('kb-tree')?.contains(page.query('kb-material-in-f1'))).toBe(true);
    // The focus follows the file to its new row.
    expect(document.activeElement).toBe(page.query('kb-material-menu-in-f1'));
    await page.dispose();
  });

  it('says why it was refused, leaving the file where it was', async () => {
    writeMaterial = () =>
      json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'not_movable' },
        409,
      );
    const page = await openPage();
    await expand('f1');
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-remove-from-folder');
    await settle();
    expect(parseToast.error).toHaveBeenCalledWith('workspace.knowledgeBase.error.notMovable');
    expect(page.query('kb-folder-files-f1')?.contains(page.query('kb-material-in-f1'))).toBe(true);
    await page.dispose();
  });

  it('asks once while a removal is answered, and leaves a focus the teacher moved', async () => {
    const answer = deferred<Response>();
    const moveOut = movable();
    writeMaterial = () => answer.promise;
    const page = await openPage();
    await expand('f1');
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-remove-from-folder');
    await settle();
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-remove-from-folder');
    await settle();
    expect(writeCalls).toHaveLength(1);
    const searchBox = page.query('kb-search')!;
    searchBox.focus();
    moveOut();
    await act(async () => answer.resolve(json({ status: 'moved', movedCount: 1 })));
    await settle();
    expect(page.query('kb-tree')?.contains(page.query('kb-material-in-f1'))).toBe(true);
    expect(document.activeElement).toBe(searchBox);
    await page.dispose();
  });

  it('says plainly when there is no other folder to move to', async () => {
    folders = () => json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 1 }] });
    const page = await openPage();
    await expand('f1');
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-move');
    expect(inDocument('kb-move-dialog')!.textContent).toContain(
      'workspace.knowledgeBase.dialog.noFolders',
    );
    expect(
      inDocument('kb-move-dialog')!.querySelectorAll('[data-testid^="kb-move-to-"]'),
    ).toHaveLength(0);
    await page.dispose();
  });
});

describe('the rows’ columns', () => {
  const gridChildren = (row: Element) =>
    [...row.children].map((child) =>
      child.className.includes('col-span-2') ? 'name×2' : child.tagName,
    );

  it('keeps a chevron slot on every row and the folder count in the Size column', async () => {
    const page = await openPage();
    await expand('f1');
    const folderRow = page.query('kb-folder-f1')!.querySelector('[data-kb-row]')!;
    const fileRow = page.query('kb-material-a')!;
    const nested = page.query('kb-material-in-f1')!;
    // A file's first slot is the empty chevron place, then its icon.
    for (const row of [fileRow, nested]) {
      const lead = row.firstElementChild!;
      expect(lead.firstElementChild?.tagName).toBe('SPAN');
      expect(lead.firstElementChild?.getAttribute('class')).toContain('size-4');
      expect(lead.children[1]?.tagName.toLowerCase()).toBe('svg');
    }
    // Indented one level inside an open folder.
    expect(nested.firstElementChild!.className).toContain('pl-6');
    expect(fileRow.firstElementChild!.className).not.toContain('pl-6');
    // Name over two columns, then Size ("N items"), Date and the ⋯: five columns as a file's.
    expect(gridChildren(folderRow)).toEqual(['name×2', 'SPAN', 'SPAN', 'SPAN']);
    expect(gridChildren(fileRow)).toEqual(['DIV', 'SPAN', 'SPAN', 'SPAN', 'SPAN']);

    await page.click('kb-folder-new');
    const newRow = page.query('kb-new-folder-row')!.querySelector('[data-kb-row]')!;
    expect(gridChildren(newRow)).toEqual(['name×2', 'SPAN', 'SPAN', 'SPAN']);
    await act(async () => {
      (inDocument('kb-new-folder-input') as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await renameFrom('kb-folder-menu-f2');
    const renameRow = page.query('kb-folder-f2')!.querySelector('[data-kb-row]')!;
    expect(gridChildren(renameRow)).toEqual(['name×2', 'SPAN', 'SPAN', 'SPAN']);
    expect(page.query('kb-folder-items-f2')?.textContent).toBe(
      'workspace.knowledgeBase.folder.items{"count":0}',
    );
    await page.dispose();
  });
});

// ── The original, and Move to… (#1835 teacher feedback 3, review §6) ──────

describe('opening or downloading the original', () => {
  it('says Open only for a type the server serves inline, Download original otherwise', async () => {
    let photoName = 'photo.png';
    library = () =>
      json({
        materials: [
          source('photo', { name: photoName, mime: 'image/png', opensInline: true }),
          source('notes', { mime: 'application/pdf', opensInline: false }),
          // An answer from before the field: downloads, as it always did for most types.
          source('older', { mime: 'image/png' }),
        ],
        limits: LIMITS,
      });
    const page = await openPage();
    const label = async (id: string) => {
      await openMenu(`kb-material-menu-${id}`);
      const item = inDocument(`kb-material-menu-${id}-open`)!;
      const text = item.textContent;
      expect(item.getAttribute('href')).toBe(`/api/materials/${id}/original`);
      await act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      await settle();
      return text;
    };
    expect(await label('photo')).toContain('workspace.knowledgeBase.actions.open');
    expect(await label('notes')).toContain('workspace.knowledgeBase.actions.downloadOriginal');
    expect(await label('older')).toContain('workspace.knowledgeBase.actions.downloadOriginal');
    // A new name does not change what the original does.
    photoName = 'Board.png';
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(page.query('kb-material-photo')?.textContent).toContain('Board.png');
    expect(await label('photo')).toContain('workspace.knowledgeBase.actions.open');
    await page.dispose();
  });
});

describe('Move to…, chosen then confirmed', () => {
  const pressed = () =>
    [...inDocument('kb-move-dialog')!.querySelectorAll('[data-testid^="kb-move-to-"]')]
      .filter((target) => target.getAttribute('aria-pressed') === 'true')
      .map((target) => target.getAttribute('data-testid'));
  const confirmButton = () => inDocument('kb-move-confirm') as HTMLButtonElement;
  const openMove = async () => {
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    await settle();
  };

  it('opens with nothing chosen and the focus on no folder; a click chooses, Move moves', async () => {
    const page = await openPage();
    await openMove();
    expect(pressed()).toEqual([]);
    expect(confirmButton().disabled).toBe(true);
    expect(document.activeElement?.getAttribute('data-testid')).not.toMatch(/^kb-move-to-/);
    await choose('kb-move-to-f2');
    expect(pressed()).toEqual(['kb-move-to-f2']);
    expect(writeCalls).toEqual([]);
    await choose('kb-move-to-f1');
    expect(pressed()).toEqual(['kb-move-to-f1']);
    expect(confirmButton().disabled).toBe(false);
    await choose('kb-move-confirm');
    await settle();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/move', body: { materialIds: ['a'], folderId: 'f1' } },
    ]);
    expect(inDocument('kb-move-dialog')).toBeNull();
    await page.dispose();
  });

  it('drops a choice the list no longer offers: a folder deleted elsewhere cannot be moved to', async () => {
    const page = await openPage();
    await openMove();
    await choose('kb-move-to-f2');
    expect(confirmButton().disabled).toBe(false);
    folders = () => json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 2 }] });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(inDocument('kb-move-to-f2')).toBeNull();
    expect(pressed()).toEqual([]);
    expect(confirmButton().disabled).toBe(true);
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('a keyboard focus is not a choice; Cancel moves nothing', async () => {
    const page = await openPage();
    await openMove();
    await act(async () => (inDocument('kb-move-to-f1') as HTMLElement).focus());
    expect(pressed()).toEqual([]);
    expect(confirmButton().disabled).toBe(true);
    await choose('kb-move-cancel');
    await settle();
    expect(inDocument('kb-move-dialog')).toBeNull();
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('keeps a refusal in the dialog to retry, and sends one move however often it is confirmed', async () => {
    const answers = [
      json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'no', reason: 'not_movable' },
        422,
      ),
    ];
    const pending = deferred<Response>();
    writeMaterial = () => answers.shift() ?? pending.promise;
    const page = await openPage();
    await openMove();
    await choose('kb-move-to-f1');
    await choose('kb-move-confirm');
    await settle();
    expect(inDocument('kb-move-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.notMovable',
    );
    expect(pressed()).toEqual(['kb-move-to-f1']);
    // Retry: one request, however often Move is pressed while it is answered.
    await act(async () => {
      confirmButton().click();
      confirmButton().click();
    });
    expect(confirmButton().disabled).toBe(true);
    expect(writeCalls).toHaveLength(2);
    await act(async () => pending.resolve(json({ status: 'moved', movedCount: 1 })));
    await settle();
    expect(inDocument('kb-move-dialog')).toBeNull();
    expect(writeCalls).toHaveLength(2);
    await page.dispose();
  });
});

// ── Organizing ─────────────────────────────────────────────────────────────

describe('organizing from the page', () => {
  it.each([
    ['before', false],
    ['after', true],
  ] as const)(
    'gives the heading the focus after Move into an open folder, the list read %s the dialog closes',
    async (_when, slowRead) => {
      // As before R8: Move's ⋯ is gone with its row, so the heading takes the
      // focus. Only Remove from folder follows the file to its new row.
      const place: Record<string, string | null> = { a: null };
      let moved = false;
      const reread = deferred<void>();
      library = async (params) => {
        if (moved && slowRead) await reread.promise;
        const folderId = params.get('folderId');
        const here = folderId === 'unfiled' ? null : folderId;
        return json({
          materials: Object.entries(place)
            .filter(([, at]) => at === here)
            .map(([id, at]) => (at ? inF1(id) : source(id))),
          limits: LIMITS,
        });
      };
      writeMaterial = (call) => {
        place.a = (call.body as { folderId: string }).folderId;
        moved = true;
        return json({ status: 'moved', movedCount: 1 });
      };
      const page = await openPage();
      await expand('f1');
      await openMenu('kb-material-menu-a');
      await choose('kb-material-menu-a-move');
      await choose('kb-move-to-f1');
      await choose('kb-move-confirm');
      await settle();
      reread.resolve();
      await settle();
      expect(page.query('kb-folder-files-f1')!.contains(inDocument('kb-material-menu-a'))).toBe(
        true,
      );
      expect(document.activeElement?.id).toBe('pro-workspace-library-title');
      await page.dispose();
    },
  );

  it('moves a source into another folder; Move to… lists folders only', async () => {
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    expect(inDocument('kb-move-to-unfiled')).toBeNull();
    await choose('kb-move-to-f1');
    await choose('kb-move-confirm');
    await settle();
    expect(writeCalls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/materials/move',
      body: { materialIds: ['a'], folderId: 'f1' },
    });
    expect(inDocument('kb-move-dialog')).toBeNull();

    await expand('f1');
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-move');
    expect(inDocument('kb-move-to-f1')).toBeNull();
    expect(inDocument('kb-move-to-unfiled')).toBeNull();
    const targets = [
      ...inDocument('kb-move-dialog')!.querySelectorAll('[data-testid^="kb-move-to-"]'),
    ];
    expect(targets.map((target) => target.getAttribute('data-testid'))).toEqual(['kb-move-to-f2']);
    expect(inDocument('kb-move-dialog')!.textContent).not.toMatch(/unfiled/i);
    await page.dispose();
  });

  it('says why a move was refused, never as a success', async () => {
    writeMaterial = () =>
      json(
        {
          success: false,
          errorCode: 'INVALID_REQUEST',
          error: 'no',
          reason: 'not_movable',
          materialIds: ['a'],
        },
        422,
      );
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    await choose('kb-move-to-f1');
    await choose('kb-move-confirm');
    await settle();
    expect(inDocument('kb-move-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.notMovable',
    );
    expect(inDocument('kb-move-dialog')).not.toBeNull();
    await page.dispose();
  });

  it('gives the focus back to the control that opened a dialog', async () => {
    const page = await openPage();
    await renameFrom('kb-material-menu-a');
    await typeInto(renameInput()!, 'Chapter 1');
    await press(renameInput()!, 'Enter');
    await settle();
    expect(document.activeElement).toBe(inDocument('kb-material-menu-a'));

    // Moved into a folder that is closed: its ⋯ is gone, the heading takes the focus.
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    library = (params) =>
      json({
        materials: params.get('folderId') === 'f1' ? [inF1('a')] : [],
        limits: LIMITS,
      });
    await choose('kb-move-to-f1');
    await choose('kb-move-confirm');
    await settle();
    expect(inDocument('kb-material-menu-a')).toBeNull();
    expect(document.activeElement?.id).toBe('pro-workspace-library-title');
    await page.dispose();
  });

  describe('when the list read after a rename drops the source from the search', () => {
    let reread: ReturnType<typeof deferred<Response>>;
    beforeEach(() => {
      let renamed = false;
      reread = deferred<Response>();
      library = () =>
        renamed
          ? reread.promise
          : json({ materials: [source('a', { name: 'Before' })], limits: LIMITS });
      writeMaterial = () => {
        renamed = true;
        return json({ status: 'renamed' });
      };
    });
    async function renameWhileSearching() {
      const page = await openPage();
      await search('Before');
      expect(libraryCalls.at(-1)?.get('query')).toBe('Before');
      await renameFrom('kb-material-menu-a');
      await typeInto(renameInput()!, 'After');
      await press(renameInput()!, 'Enter');
      await settle();
      expect(document.activeElement).toBe(inDocument('kb-material-menu-a'));
      return page;
    }

    it('gives the focus to the heading once that read removes its ⋯', async () => {
      const page = await renameWhileSearching();
      await act(async () => reread.resolve(json({ materials: [], limits: LIMITS })));
      await settle();
      expect(inDocument('kb-material-menu-a')).toBeNull();
      expect(document.activeElement?.id).toBe('pro-workspace-library-title');
      await page.dispose();
    });

    it('leaves the focus alone once the teacher has moved it', async () => {
      const page = await renameWhileSearching();
      const searchBox = page.query('kb-search')!;
      searchBox.focus();
      await act(async () => reread.resolve(json({ materials: [], limits: LIMITS })));
      await settle();
      expect(document.activeElement).toBe(searchBox);
      await page.dispose();
    });
  });

  it('opens the original in a new tab, and hands the source to a conversation', async () => {
    const onChat = vi.fn();
    const page = await openPage({ onChatWithMaterial: onChat });
    await openMenu('kb-material-menu-a');
    const link = inDocument('kb-material-menu-a-open') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/api/materials/a/original');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    await choose('kb-material-menu-a-chat');
    expect(onChat).toHaveBeenCalledWith({
      materialId: 'a',
      name: 'a.pdf',
      bytes: 1024,
      mimeType: 'application/pdf',
      extractionStatus: 'done',
    });
    // Choosing it uploads, attaches and posts nothing by itself.
    expect(writeCalls).toEqual([]);
    expect(uploadCalls).toEqual([]);
    await page.dispose();
  });
});

// ── Deleting ───────────────────────────────────────────────────────────────

describe('deleting from the page', () => {
  const confirm = async () => {
    await choose('kb-delete-dialog-confirm');
    await settle();
  };
  const deletes = () => writeCalls.filter((call) => call.method === 'DELETE');
  const noContent = () => new Response(null, { status: 204 });

  it('says what deleting a source means, then deletes it and reads the list again', async () => {
    writeMaterial = () => noContent();
    const page = await openPage();
    const reads = libraryCalls.length;
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    const text = inDocument('kb-delete-dialog')?.textContent ?? '';
    expect(text).toContain('workspace.knowledgeBase.delete.materialTitle{"name":"a.pdf"}');
    expect(text).toContain('workspace.knowledgeBase.delete.materialLinks');
    expect(text).toContain('workspace.knowledgeBase.delete.materialCourses');
    expect(text).toContain('workspace.knowledgeBase.delete.cannotUndo');
    expect(deletes()).toEqual([]);

    await confirm();
    expect(deletes()).toEqual([{ method: 'DELETE', path: '/api/materials/a', body: undefined }]);
    expect(inDocument('kb-delete-dialog')).toBeNull();
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('moves the focus into the confirmation, onto cancel, and closes from there', async () => {
    writeMaterial = () => noContent();
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    await settle();
    expect(inDocument('kb-delete-dialog')!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(inDocument('kb-delete-dialog-cancel'));
    await choose('kb-delete-dialog-cancel');
    expect(inDocument('kb-delete-dialog')).toBeNull();
    expect(deletes()).toEqual([]);
    await settle();
    expect(document.activeElement).toBe(inDocument('kb-material-menu-a'));
    await page.dispose();
  });

  it('gives the focus to the heading once the source is deleted', async () => {
    writeMaterial = () => noContent();
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    await confirm();
    await settle();
    expect(inDocument('kb-delete-dialog')).toBeNull();
    expect(document.activeElement?.id).toBe('pro-workspace-library-title');
    await page.dispose();
  });

  it('takes a 404 on the retry after a failed delete as done', async () => {
    const answers = [
      json({ success: false, errorCode: 'INTERNAL_ERROR', error: 'lost' }, 500),
      new Response('Not found', { status: 404 }),
    ];
    writeMaterial = () => answers.shift()!;
    const page = await openPage();
    const reads = libraryCalls.length;
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    await confirm();
    expect(inDocument('kb-delete-dialog-message')?.textContent).toBe(
      'workspace.knowledgeBase.error.save',
    );
    expect(inDocument('kb-delete-dialog-confirm')?.textContent).toBe(
      'workspace.knowledgeBase.retry',
    );
    await confirm();
    expect(deletes()).toHaveLength(2);
    expect(inDocument('kb-delete-dialog')).toBeNull();
    expect(libraryCalls.length).toBe(reads + 2);
    await page.dispose();
  });

  it('says a source deleted elsewhere is gone, on a first 404, without a retry', async () => {
    writeMaterial = () => new Response('Not found', { status: 404 });
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    await confirm();
    expect(inDocument('kb-delete-dialog-message')?.textContent).toBe(
      'workspace.knowledgeBase.error.gone',
    );
    expect(inDocument('kb-delete-dialog-confirm')).toBeNull();
    expect(inDocument('kb-delete-dialog')?.textContent).toContain(
      'workspace.knowledgeBase.dialog.close',
    );
    await page.dispose();
  });

  it('retries a busy owner (503) until the delete goes through', async () => {
    const answers = [json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503), noContent()];
    writeMaterial = () => answers.shift()!;
    const page = await openPage();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-delete');
    await confirm();
    expect(inDocument('kb-delete-dialog-message')?.textContent).toBe(
      'workspace.knowledgeBase.error.busy',
    );
    await confirm();
    expect(inDocument('kb-delete-dialog')).toBeNull();
    await page.dispose();
  });

  it('confirms the file count before deleting a non-empty folder, without deleting files', async () => {
    writeMaterial = () => noContent();
    const page = await openPage();
    await openMenu('kb-folder-menu-f1');
    await choose('kb-folder-menu-f1-delete');
    expect(inDocument('kb-delete-dialog')?.textContent).toContain(
      'workspace.knowledgeBase.delete.folderContents{"count":2}',
    );
    expect(deletes()).toEqual([]);
    await confirm();
    expect(deletes()).toEqual([
      { method: 'DELETE', path: '/api/materials/folders/f1', body: undefined },
    ]);
    expect(inDocument('kb-delete-dialog')).toBeNull();
    await page.dispose();
  });

  it('a deleted folder leaves the list; another open folder stays open', async () => {
    writeMaterial = () => noContent();
    const page = await openPage();
    await expand('f1');
    await expand('f2');
    folders = () => json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 2 }] });
    await openMenu('kb-folder-menu-f2');
    await choose('kb-folder-menu-f2-delete');
    await confirm();
    expect(page.query('kb-folder-f2')).toBeNull();
    expect(page.query('kb-folder-toggle-f1')?.getAttribute('aria-expanded')).toBe('true');
    await page.dispose();
  });
});

describe('reading a delete attempt', () => {
  const refusal = (status: number, reason?: string) =>
    new MaterialLibraryRequestError(status, reason);

  it('is done on a 204, or on a 404 that follows a failed attempt', () => {
    expect(deleteOutcomeOf(null, false)).toEqual({ outcome: 'deleted' });
    expect(deleteOutcomeOf(refusal(404), true)).toEqual({ outcome: 'deleted' });
    expect(deleteOutcomeOf(refusal(404), false)).toMatchObject({ outcome: 'gone' });
  });

  it('retries what may or may not have happened, and stops on what cannot', () => {
    expect(deleteOutcomeOf(refusal(500), false)).toMatchObject({ outcome: 'retry' });
    expect(deleteOutcomeOf(refusal(503), false)).toMatchObject({ outcome: 'retry' });
    expect(deleteOutcomeOf(new TypeError('Failed to fetch'), false)).toMatchObject({
      outcome: 'retry',
    });
    expect(deleteOutcomeOf(refusal(409, 'not_empty'), true)).toMatchObject({
      outcome: 'notEmpty',
    });
    expect(deleteOutcomeOf(refusal(403), true)).toMatchObject({ outcome: 'identity' });
  });
});

describe('the library client and formats', () => {
  it('reads all three refusal shapes', async () => {
    await expect(
      materialLibraryErrorOf(
        json({ success: false, errorCode: 'X', error: 'e', reason: 'not_empty' }, 409),
      ),
    ).resolves.toMatchObject({ status: 409, reason: 'not_empty', code: 'X' });
    await expect(
      materialLibraryErrorOf(json({ error: { code: 'OWNER_BUSY', message: 'm' } }, 503)),
    ).resolves.toMatchObject({ status: 503, code: 'OWNER_BUSY' });
    await expect(
      materialLibraryErrorOf(new Response('Not found', { status: 404 })),
    ).resolves.toMatchObject({ status: 404, reason: undefined, code: undefined });
  });

  it('passes a folder’s date through, and says whether a new folder was created', async () => {
    folders = () => json({ folders: [{ id: 'f1', name: 'A', materialCount: 1, updatedAt: 42 }] });
    await expect(fetchMaterialLibraryFolders()).resolves.toEqual([
      { id: 'f1', name: 'A', materialCount: 1, updatedAt: 42 },
    ]);
    writeMaterial = () => json({ folder: { id: 'f1', name: 'A' }, created: false }, 200);
    await expect(createLibraryFolder('a')).resolves.toEqual({ folderId: 'f1', created: false });
    writeMaterial = () => json({ folder: { id: 'f9', name: 'B' }, created: true }, 201);
    await expect(createLibraryFolder('B')).resolves.toEqual({ folderId: 'f9', created: true });
  });

  it('formats byte counts and the date column for people', () => {
    expect(formatMaterialBytes(512, 'en-US')).toBe('512 B');
    expect(formatMaterialBytes(1536, 'en-US')).toBe('1.5 KB');
    expect(formatMaterialBytes(50 * 1024 * 1024, 'en-US')).toBe('50 MB');
    const thisYear = new Date().getFullYear();
    expect(formatLibraryDate(`${thisYear}-03-04T12:00:00Z`, 'en-US')).toBe('03/04');
    expect(formatLibraryDate('2020-03-04T12:00:00Z', 'en-US')).toBe('03/04/2020');
    expect(formatLibraryDate(undefined, 'en-US')).toBe('');
    expect(formatLibraryDate('not a date', 'en-US')).toBe('');
  });
});

describe('public extraction failure explanations', () => {
  it.each(MATERIAL_EXTRACTION_REASON_CODES)(
    'shows the localized %s explanation in a popover',
    async (reasonCode) => {
      library = () =>
        json({
          materials: [
            source('bad', {
              extraction: { status: 'failed', reasonCode, reason: 'PRIVATE_RAW_DETAIL' },
            }),
          ],
          limits: LIMITS,
        });
      const page = await openPage();
      const status = page.query('kb-status-bad')!;
      expect(status.textContent).toBe(`workspace.knowledgeBase.failure.${reasonCode}.label`);
      const button = status.querySelector('button')!;
      await act(async () => {
        button.focus();
        button.click();
      });
      await settle();
      const dialog = document.querySelector('[role="dialog"]')!;
      // The duration limit is the extractor's own number, passed in.
      expect(dialog.textContent).toBe(
        `workspace.knowledgeBase.failure.${reasonCode}.description${
          reasonCode === 'media_too_long' ? '{"minutes":90}' : ''
        }`,
      );
      expect(document.body.innerHTML).not.toContain('PRIVATE_RAW_DETAIL');
      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(button);
      await page.dispose();
    },
  );

  it('falls back for unknown and old errors, and clears a known explanation when parsing restarts', async () => {
    let status = 'failed';
    library = () =>
      json({
        materials: [
          source('unknown', {
            extraction: {
              status: 'failed',
              reasonCode: 'future_code',
              reason: 'PRIVATE_RAW_DETAIL',
            },
          }),
          source('old', { extraction: { status: 'failed', reason: 'PRIVATE_RAW_DETAIL' } }),
          source('known', { extraction: { status, reasonCode: 'storage_full' } }),
        ],
        limits: LIMITS,
      });
    const page = await openPage();
    for (const id of ['unknown', 'old']) {
      expect(page.query(`kb-status-${id}`)!.textContent).toBe(
        'workspace.knowledgeBase.status.failed',
      );
      expect(page.query(`kb-status-${id}`)!.querySelector('button')).toBeNull();
    }
    await act(async () => {
      page.query('kb-status-known')!.querySelector('button')!.click();
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    status = 'pending';
    // Changing query drives the real hook through a fresh read, including the search rendering.
    await search('known');
    expect(page.query('kb-status-known')!.textContent).toBe(
      'workspace.knowledgeBase.status.parsing',
    );
    expect(page.query('kb-status-known')!.querySelector('button')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('PRIVATE_RAW_DETAIL');
    await page.dispose();
  });
});

describe('R6 manual parsing', () => {
  it.each([
    { initial: 'idle', fails: 'listing', recovered: 'done', terminal: 'done' },
    { initial: 'failed', fails: 'folders', recovered: 'pending', terminal: 'failed' },
  ])(
    'recovers after Parse succeeds but the first $fails refresh fails ($initial)',
    async ({ initial, fails, recovered, terminal }) => {
      let state = initial;
      let failRead = false;
      library = () =>
        failRead && fails === 'listing'
          ? json({}, 503)
          : json({
              materials: [source('recover', { extraction: { status: state } })],
              limits: LIMITS,
            });
      folders = () => (failRead && fails === 'folders' ? json({}, 503) : json({ folders: [] }));
      writeMaterial = () => {
        state = 'pending';
        failRead = true;
        return json({ status: 'pending', queued: true });
      };
      const page = await openPage();
      await openMenu('kb-material-menu-recover');
      await choose('kb-material-menu-recover-parse');
      await settle();
      expect(page.query('kb-status-recover')!.dataset.status).toBe(initial);
      expect(page.query('kb-stale')).not.toBeNull();
      const failedReads = libraryCalls.length;
      // A second failed read must not consume the need to observe the accepted write.
      await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
      expect(libraryCalls.length).toBeGreaterThan(failedReads);
      failRead = false;
      state = recovered;
      await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
      expect(page.query('kb-status-recover')!.dataset.status).toBe(recovered);
      expect(page.query('kb-stale')).toBeNull();
      if (recovered === 'pending') {
        state = terminal;
        await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
        expect(page.query('kb-status-recover')!.dataset.status).toBe(terminal);
      }
      const settledReads = libraryCalls.length;
      await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
      expect(libraryCalls.length).toBe(settledReads);
      expect(writeCalls).toHaveLength(1); // Retrying the read must never enqueue again.
      await page.dispose();
    },
    20000,
  );

  it('pauses post-Parse recovery while hidden and cancels it on unmount', async () => {
    let failRead = false;
    library = () =>
      failRead
        ? json({}, 503)
        : json({
            materials: [source('pause', { extraction: { status: 'idle' } })],
            limits: LIMITS,
          });
    writeMaterial = () => {
      failRead = true;
      return json({ status: 'pending', queued: true });
    };
    const page = await openPage();
    await openMenu('kb-material-menu-pause');
    await choose('kb-material-menu-pause-parse');
    await settle();
    const reads = libraryCalls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
      expect(libraryCalls.length).toBe(reads);
      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await settle();
      expect(libraryCalls.length).toBeGreaterThan(reads);
      await page.dispose();
      const unmountedReads = libraryCalls.length;
      await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
      expect(libraryCalls.length).toBe(unmountedReads);
    } finally {
      visibility.mockRestore();
    }
  }, 12000);

  it('offers parse/reparse only for idle/failed and rereads after a successful click', async () => {
    let state = 'idle';
    library = () =>
      json({ materials: [source('parse-me', { extraction: { status: state } })], limits: LIMITS });
    writeMaterial = () => {
      state = 'pending';
      return json({ status: 'pending', queued: true });
    };
    const page = await openPage();
    await openMenu('kb-material-menu-parse-me');
    expect(inDocument('kb-material-menu-parse-me-parse')).not.toBeNull();
    expect(inDocument('kb-material-menu-parse-me-parse')!.textContent).toContain(
      'workspace.knowledgeBase.actions.parse',
    );
    const reads = libraryCalls.length;
    await choose('kb-material-menu-parse-me-parse');
    await settle();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/parse-me/extraction', body: {} },
    ]);
    expect(libraryCalls.length).toBeGreaterThan(reads);
    expect(page.query('kb-status-parse-me')!.dataset.status).toBe('pending');
    expect(document.activeElement).toBe(page.query('kb-material-menu-parse-me'));
    for (const next of ['pending', 'running', 'done', 'failed']) {
      state = next;
      await search(next);
      await openMenu('kb-material-menu-parse-me');
      if (next === 'failed')
        expect(inDocument('kb-material-menu-parse-me-parse')!.textContent).toContain(
          'workspace.knowledgeBase.actions.reparse',
        );
      else expect(inDocument('kb-material-menu-parse-me-parse')).toBeNull();
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      await settle();
    }
    await page.dispose();
  });

  it('reports a parse refusal with the existing write error and returns focus without claiming success', async () => {
    library = () =>
      json({ materials: [source('bad', { extraction: { status: 'failed' } })], limits: LIMITS });
    writeMaterial = () => json({ reason: 'unavailable' }, 503);
    const page = await openPage();
    await openMenu('kb-material-menu-bad');
    expect(inDocument('kb-material-menu-bad-parse')).not.toBeNull();
    await choose('kb-material-menu-bad-parse');
    await settle();
    expect(parseToast.error).toHaveBeenCalledWith('workspace.knowledgeBase.error.busy');
    const refusedReads = libraryCalls.length;
    await settle(MATERIAL_LIBRARY_TREE_POLL_MS + 100);
    expect(libraryCalls.length).toBe(refusedReads);
    expect(writeCalls).toHaveLength(1);
    expect(page.query('kb-status-bad')!.dataset.status).toBe('failed');
    expect(document.activeElement).toBe(page.query('kb-material-menu-bad'));
    await page.dispose();
  });
});
