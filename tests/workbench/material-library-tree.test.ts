// @vitest-environment jsdom
/**
 * The knowledge base as one file-manager list (#1835 review): the data
 * contract of `useMaterialLibraryTree` -- what it reads, when, and what it
 * keeps when reads interleave. Every case checks what the hook returns
 * (files, expanded folders, `hasMore`, errors), not only the requests.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MATERIAL_LIBRARY_TREE_POLL_MS,
  useMaterialLibraryTree,
  type MaterialLibraryTree,
} from '@/lib/workbench/use-material-library-tree';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

// ── A paging server ────────────────────────────────────────────────────────

interface RawFile {
  materialId: string;
  name: string;
  bytes: number;
  mime: string;
  folderId: string | null;
  folderName?: string;
  extraction: { status: string };
  createdAt: string;
}
const file = (id: string, status = 'done', folderId: string | null = null): RawFile => ({
  materialId: id,
  name: `${id}.pdf`,
  bytes: 1,
  mime: 'application/pdf',
  folderId,
  ...(folderId ? { folderName: `${folderId} name` } : {}),
  extraction: { status },
  createdAt: '2026-10-08T00:00:00.000Z',
});
const LIMITS = {
  documentMaxBytes: 1,
  mediaMaxBytes: 1,
  maxCount: 100,
  maxTotalBytes: 2,
  usedCount: 0,
  usedBytes: 0,
  assetQuotaBytes: null,
  assetUsedBytes: 0,
};

/** Pages per listing: `unfiled`, `folder:<id>`, `query:<text>`. */
let pages = new Map<string, RawFile[][]>();
let folders: { id: string; name: string; materialCount: number }[] = [];
let cursorSeq = 0;

interface Call {
  readonly kind: 'folders' | 'listing';
  readonly params: URLSearchParams;
  readonly signal: AbortSignal | undefined;
  body?: { materials?: RawFile[]; nextBefore?: string; limits?: unknown };
}
let calls: Call[] = [];

interface Gate {
  readonly match: (call: Call) => boolean;
  readonly opened: Promise<void>;
  readonly open: () => void;
  readonly ignoreAbort: boolean;
  failStatus?: number;
  used: boolean;
}
let gates: Gate[] = [];
/** The next matching request waits until `open()` (or answers `fail` once opened). */
function hold(match: (call: Call) => boolean, options: { ignoreAbort?: boolean } = {}) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const gate: Gate = {
    match,
    opened,
    open,
    ignoreAbort: options.ignoreAbort ?? false,
    used: false,
  };
  gates.push(gate);
  // `act`'s thenable does not chain what `.then` returns: await each step.
  return {
    open: async () => {
      await act(async () => gate.open());
      await settle();
    },
    fail: async (status: number) => {
      gate.failStatus = status;
      await act(async () => gate.open());
      await settle();
    },
  };
}

const listingKey = (params: URLSearchParams) => {
  const query = params.get('query');
  if (query) return `query:${query}`;
  const folderId = params.get('folderId');
  return folderId === 'unfiled' ? 'unfiled' : `folder:${folderId}`;
};
function answer(call: Call): Response {
  if (call.kind === 'folders') return Response.json({ folders });
  const key = listingKey(call.params);
  const all = pages.get(key) ?? [[]];
  const before = call.params.get('before');
  const index = before ? Number(before.split('|')[2]) : 0;
  const body: NonNullable<Call['body']> = { materials: all[index] ?? [] };
  // A fresh cursor every answer: a refresh's later page must use the one
  // this refresh's previous page returned.
  if (index + 1 < all.length) body.nextBefore = `c|${key}|${index + 1}|${(cursorSeq += 1)}`;
  if (call.params.get('limits') !== '0') body.limits = LIMITS;
  call.body = body;
  return Response.json(body);
}
const abortError = () => new DOMException('aborted', 'AbortError');
function abortable(promise: Promise<Response>, signal: AbortSignal | undefined, ignore: boolean) {
  if (!signal || ignore) return promise;
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()));
    promise.then(resolve, reject);
  });
}

// ── The hook, mounted ──────────────────────────────────────────────────────

let latest!: MaterialLibraryTree;
const report = (value: MaterialLibraryTree) => {
  latest = value;
};
function Host({
  query,
  uploading,
  onValue,
}: {
  query: string;
  uploading?: boolean;
  onValue: (value: MaterialLibraryTree) => void;
}) {
  onValue(useMaterialLibraryTree({ query, uploading }));
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Let answers land: reading a response body takes several macrotasks in jsdom. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
async function mount(query = '', uploading = false) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Host, { query, uploading, onValue: report })));
  await settle();
}
const rerender = async (query: string, uploading = false) => {
  await act(async () => root!.render(createElement(Host, { query, uploading, onValue: report })));
  await settle();
};
const run = async (action: () => void) => {
  await act(async () => action());
  await settle();
};

const ids = (files: readonly { materialId: string }[]) => files.map((f) => f.materialId);
const listings = (match: (params: URLSearchParams) => boolean = () => true) =>
  calls.filter((call) => call.kind === 'listing' && match(call.params));
const rounds = () => calls.filter((call) => call.kind === 'folders').length;
const inScope = (scope: string) => (params: URLSearchParams) =>
  params.get('folderId') === scope && !params.get('query');
const isSearch = (text: string) => (params: URLSearchParams) => params.get('query') === text;
const setVisibility = async (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  pages = new Map([['unfiled', [[file('u1'), file('u2')]]]]);
  folders = [
    { id: 'f1', name: 'Functions', materialCount: 2 },
    { id: 'f2', name: 'Lab', materialCount: 1 },
    { id: 'f3', name: 'Exams', materialCount: 1 },
  ];
  pages.set('folder:f1', [[file('a1', 'done', 'f1'), file('a2', 'done', 'f1')]]);
  pages.set('folder:f2', [[file('b1', 'done', 'f2')]]);
  pages.set('folder:f3', [[file('c1', 'done', 'f3')]]);
  cursorSeq = 0;
  calls = [];
  gates = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test');
      const call: Call = {
        kind: url.pathname === '/api/materials/folders' ? 'folders' : 'listing',
        params: url.searchParams,
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      const computed = answer(call);
      const gate = gates.find((candidate) => !candidate.used && candidate.match(call));
      if (!gate) return abortable(Promise.resolve(computed), call.signal, false);
      gate.used = true;
      const delivered = gate.opened.then(() =>
        gate.failStatus
          ? Response.json(
              { success: false, errorCode: 'X', error: 'x' },
              { status: gate.failStatus },
            )
          : computed,
      );
      return abortable(delivered, call.signal, gate.ignoreAbort);
    }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── T1–T3: reading the tree ────────────────────────────────────────────────

describe('reading the tree', () => {
  it('T1 reads the folders and the first page of the files in no folder, nothing inside a folder', async () => {
    await mount();
    expect(rounds()).toBe(1);
    expect(listings()).toHaveLength(1);
    const [top] = listings();
    expect(top.params.get('folderId')).toBe('unfiled');
    expect(top.params.get('limits')).toBeNull();
    expect(latest.mode).toBe('tree');
    expect(latest.folders.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);
    expect(latest.root.status).toBe('ready');
    expect(latest.limits).toEqual(LIMITS);
    expect(latest.expanded).toEqual([]);
    expect(latest.refreshing).toBe(false);
  });

  it('T2 expands a folder on demand, drops its pages when collapsed, and reads again from the top', async () => {
    await mount();
    await run(() => latest.expand('f1'));
    expect(listings(inScope('f1'))).toHaveLength(1);
    expect(listings(inScope('f1'))[0].params.get('limits')).toBe('0');
    expect(latest.expanded).toEqual(['f1']);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a1', 'a2']);

    await run(() => latest.collapse('f1'));
    expect(latest.expanded).toEqual([]);
    expect(latest.folder('f1')).toBeNull();

    pages.set('folder:f1', [[file('a3', 'done', 'f1')]]);
    await run(() => latest.expand('f1'));
    const reads = listings(inScope('f1'));
    expect(reads).toHaveLength(2);
    expect(reads[1].params.get('before')).toBeNull();
    expect(ids(latest.folder('f1')!.files)).toEqual(['a3']);
  });

  it('T3 loads more for each node from its own cursor, keeping a file listed twice once', async () => {
    pages.set('unfiled', [
      [file('u1'), file('u2')],
      [file('u2'), file('u3')],
    ]);
    pages.set('folder:f1', [[file('a1', 'done', 'f1')], [file('a2', 'done', 'f1')]]);
    await mount();
    await run(() => latest.expand('f1'));
    expect(latest.root.hasMore).toBe(true);
    expect(latest.folder('f1')!.hasMore).toBe(true);
    const rootCursor = listings(inScope('unfiled'))[0].body!.nextBefore;
    const folderCursor = listings(inScope('f1'))[0].body!.nextBefore;

    await run(() => latest.loadMore('root'));
    const more = listings(inScope('unfiled')).at(-1)!;
    expect(more.params.get('before')).toBe(rootCursor);
    expect(more.params.get('limits')).toBe('0');
    expect(ids(latest.root.files)).toEqual(['u1', 'u2', 'u3']);
    expect(latest.root.hasMore).toBe(false);

    await run(() => latest.loadMore({ folderId: 'f1' }));
    expect(listings(inScope('f1')).at(-1)!.params.get('before')).toBe(folderCursor);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a1', 'a2']);
    expect(latest.folder('f1')!.hasMore).toBe(false);
  });
});

// ── T4–T7: refreshing ──────────────────────────────────────────────────────

describe('refreshing what is shown', () => {
  async function twoPagesTopAndF1() {
    pages.set('unfiled', [[file('u1')], [file('u2')]]);
    pages.set('folder:f1', [[file('a1', 'done', 'f1')], [file('a2', 'done', 'f1')]]);
    await mount();
    await run(() => latest.expand('f1'));
    await run(() => latest.expand('f2'));
    await run(() => latest.loadMore('root'));
    await run(() => latest.loadMore({ folderId: 'f1' }));
    calls = [];
  }

  it('T4 rereads as many pages as each node shows, each from this refresh’s cursor, swapping only once all arrived', async () => {
    await twoPagesTopAndF1();
    pages.set('unfiled', [[file('u0')], [file('u1'), file('u2')]]);
    const f2 = hold((call) => call.kind === 'listing' && inScope('f2')(call.params));
    await run(() => latest.reload());

    expect(rounds()).toBe(1);
    const top = listings(inScope('unfiled'));
    expect(top).toHaveLength(2);
    expect(top[0].params.get('limits')).toBeNull();
    expect(top[1].params.get('limits')).toBe('0');
    expect(top[1].params.get('before')).toBe(top[0].body!.nextBefore);
    const f1 = listings(inScope('f1'));
    expect(f1).toHaveLength(2);
    expect(f1[1].params.get('before')).toBe(f1[0].body!.nextBefore);
    expect(f1.every((call) => call.params.get('limits') === '0')).toBe(true);
    expect(listings(inScope('f2'))).toHaveLength(1);
    // Not swapped yet: f2 has not answered.
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);
    expect(latest.refreshing).toBe(true);

    await f2.open();
    expect(ids(latest.root.files)).toEqual(['u0', 'u1', 'u2']);
    expect(latest.root.hasMore).toBe(false);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a1', 'a2']);
    expect(latest.expanded).toEqual(['f1', 'f2']);
    expect(latest.refreshing).toBe(false);
    expect(latest.error).toBeNull();
  });

  it('T4b stops where a node ends now: no padding to the old page count, no old cursor', async () => {
    pages.set('unfiled', [[file('u1')], [file('u2')], [file('u3')]]);
    await mount();
    await run(() => latest.loadMore('root'));
    await run(() => latest.loadMore('root'));
    expect(ids(latest.root.files)).toEqual(['u1', 'u2', 'u3']);

    pages.set('unfiled', [[file('u1')]]);
    calls = [];
    await run(() => latest.reload());
    expect(listings(inScope('unfiled'))).toHaveLength(1);
    expect(ids(latest.root.files)).toEqual(['u1']);
    expect(latest.root.hasMore).toBe(false);

    calls = [];
    await run(() => latest.reload());
    expect(listings(inScope('unfiled'))).toHaveLength(1);
  });

  it('T5 a failed refresh keeps what is shown and the expanded folders, and says it failed', async () => {
    await twoPagesTopAndF1();
    const f1 = hold((call) => call.kind === 'listing' && inScope('f1')(call.params));
    pages.set('unfiled', [[file('new')]]);
    await run(() => latest.reload());
    await f1.fail(500);
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a1', 'a2']);
    expect(latest.expanded).toEqual(['f1', 'f2']);
    expect(latest.root.status).toBe('ready');
    expect((latest.error as { status?: number }).status).toBe(500);
    expect(latest.refreshing).toBe(false);
  });

  it('T6 shows the old data, not "loading", while a refresh runs', async () => {
    await mount();
    const top = hold((call) => call.kind === 'listing');
    await run(() => latest.reload());
    expect(latest.refreshing).toBe(true);
    expect(latest.root.status).toBe('ready');
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);
    await top.open();
    expect(latest.refreshing).toBe(false);
  });

  it('T7 a folder deleted elsewhere leaves the tree; the other expanded folders stay open', async () => {
    await mount();
    await run(() => latest.expand('f1'));
    await run(() => latest.expand('f2'));
    folders = folders.filter((folder) => folder.id !== 'f2');
    await run(() => latest.reload());
    expect(latest.expanded).toEqual(['f1']);
    expect(latest.folder('f2')).toBeNull();
    expect(ids(latest.folder('f1')!.files)).toEqual(['a1', 'a2']);
  });
});

// ── T8–T10c: the teacher acts while reads are on their way ─────────────────

describe('the teacher’s actions win over reads in flight', () => {
  it('T8 a folder expanded during a refresh keeps its own read', async () => {
    await mount();
    const top = hold((call) => call.kind === 'listing' && inScope('unfiled')(call.params));
    await run(() => latest.reload());
    await run(() => latest.expand('f3'));
    expect(ids(latest.folder('f3')!.files)).toEqual(['c1']);
    await top.open();
    expect(latest.expanded).toEqual(['f3']);
    expect(ids(latest.folder('f3')!.files)).toEqual(['c1']);
    expect(latest.folder('f3')!.status).toBe('ready');
  });

  it('T8b a refresh reads again a folder still reading its first page; the older read does not land', async () => {
    await mount();
    const first = hold((call) => call.kind === 'listing' && inScope('f1')(call.params), {
      ignoreAbort: true,
    });
    await run(() => latest.expand('f1'));
    expect(latest.folder('f1')!.status).toBe('loading');
    pages.set('folder:f1', [[file('a2', 'done', 'f1')]]);
    await run(() => latest.reload());
    const reads = listings(inScope('f1'));
    expect(reads).toHaveLength(2);
    expect(reads[0].signal?.aborted).toBe(true);
    expect(latest.expanded).toEqual(['f1']);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a2']);
    expect(latest.folder('f1')!.status).toBe('ready');
    await first.open();
    expect(ids(latest.folder('f1')!.files)).toEqual(['a2']);
  });

  it('T9 a folder collapsed during a refresh is not expanded again by it', async () => {
    await mount();
    await run(() => latest.expand('f1'));
    const top = hold((call) => call.kind === 'listing' && inScope('unfiled')(call.params));
    await run(() => latest.reload());
    await run(() => latest.collapse('f1'));
    await top.open();
    expect(latest.expanded).toEqual([]);
    expect(latest.folder('f1')).toBeNull();
  });

  it('T10 an expand answered after the folder was collapsed is dropped', async () => {
    await mount();
    const read = hold((call) => call.kind === 'listing' && inScope('f1')(call.params), {
      ignoreAbort: true,
    });
    await run(() => latest.expand('f1'));
    await run(() => latest.collapse('f1'));
    await read.open();
    expect(latest.expanded).toEqual([]);
    expect(latest.folder('f1')).toBeNull();
  });

  it('T10b collapsed and expanded again during a refresh: the refresh does not land on the new expansion', async () => {
    await mount();
    await run(() => latest.expand('f1'));
    // The refresh reads f1 as it is now.
    const old = hold((call) => call.kind === 'listing' && inScope('f1')(call.params), {
      ignoreAbort: true,
    });
    await run(() => latest.reload());
    await run(() => latest.collapse('f1'));
    pages.set('folder:f1', [[file('fresh', 'done', 'f1')]]);
    await run(() => latest.expand('f1'));
    expect(ids(latest.folder('f1')!.files)).toEqual(['fresh']);
    await old.open();
    expect(latest.expanded).toEqual(['f1']);
    expect(ids(latest.folder('f1')!.files)).toEqual(['fresh']);
  });

  it('T10c a refresh supersedes a "load more" in flight: its late page is not appended', async () => {
    pages.set('unfiled', [[file('u1')], [file('u2')]]);
    await mount();
    const more = hold((call) => call.kind === 'listing' && call.params.get('before') !== null, {
      ignoreAbort: true,
    });
    await run(() => latest.loadMore('root'));
    expect(latest.root.loadingMore).toBe(true);
    const signal = listings().at(-1)!.signal!;
    await run(() => latest.reload());
    expect(signal.aborted).toBe(true);
    await more.open();
    expect(ids(latest.root.files)).toEqual(['u1']);
    expect(latest.root.hasMore).toBe(true);
    expect(latest.root.loadingMore).toBe(false);
    calls = [];
    await run(() => latest.reload());
    expect(listings(inScope('unfiled'))).toHaveLength(1);
  });

  it('T13 "load more" waits while a refresh runs', async () => {
    pages.set('unfiled', [[file('u1')], [file('u2')]]);
    await mount();
    const top = hold((call) => call.kind === 'listing');
    await run(() => latest.reload());
    calls = [];
    await run(() => latest.loadMore('root'));
    expect(listings()).toHaveLength(0);
    await top.open();
    expect(ids(latest.root.files)).toEqual(['u1']);
  });
});

// ── T11–T12: search ────────────────────────────────────────────────────────

describe('search', () => {
  it('T11 a query is one flat list across folders; a newer query wins; its refresh leaves the tree alone', async () => {
    pages.set('query:lab', [[file('b1', 'done', 'f2'), file('u9')]]);
    pages.set('query:labs', [[file('b2', 'done', 'f2')]]);
    await mount();
    await run(() => latest.expand('f1'));
    calls = [];
    await rerender('lab');
    const search = listings(isSearch('lab'));
    expect(search).toHaveLength(1);
    expect(search[0].params.get('folderId')).toBeNull();
    expect(search[0].params.get('limits')).toBeNull();
    expect(latest.mode).toBe('search');
    expect(ids(latest.results.files)).toEqual(['b1', 'u9']);
    expect(latest.results.files[0].folderName).toBe('f2 name');

    const slow = hold((call) => call.kind === 'listing' && isSearch('labs')(call.params), {
      ignoreAbort: true,
    });
    const slowest = hold((call) => call.kind === 'listing' && isSearch('lab')(call.params), {
      ignoreAbort: true,
    });
    await rerender('labs');
    await rerender('lab');
    await slowest.open();
    await slow.open();
    expect(ids(latest.results.files)).toEqual(['b1', 'u9']);

    calls = [];
    await run(() => latest.reload());
    expect(listings(isSearch('lab'))).toHaveLength(1);
    expect(listings((params) => !params.get('query'))).toHaveLength(0);
    expect(latest.limits).toEqual(LIMITS);
  });

  it('T12 clearing the query goes back to the tree with the same folders open, read again', async () => {
    pages.set('query:x', [[file('u1')]]);
    await mount();
    await run(() => latest.expand('f1'));
    await rerender('x');
    pages.set('folder:f1', [[file('a9', 'done', 'f1')]]);
    calls = [];
    await rerender('');
    expect(latest.mode).toBe('tree');
    expect(latest.expanded).toEqual(['f1']);
    expect(listings(inScope('unfiled'))).toHaveLength(1);
    expect(listings(inScope('f1'))).toHaveLength(1);
    expect(ids(latest.folder('f1')!.files)).toEqual(['a9']);
  });
});

// ── T14–T15: polling and runs ──────────────────────────────────────────────

describe('polling and in-run changes', () => {
  it('T14 polls while a shown file parses, stops when done, when hidden, and once its folder is collapsed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    pages.set('folder:f1', [[file('a1', 'running', 'f1')]]);
    await act(async () => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      root.render(createElement(Host, { query: '', onValue: report }));
    });
    await tick(0);
    await act(async () => latest.expand('f1'));
    await tick(0);
    const start = rounds();
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    expect(rounds()).toBe(start + 1);

    await setVisibility('hidden');
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS * 2);
    expect(rounds()).toBe(start + 1);
    await setVisibility('visible'); // a return: one refresh
    await tick(0);
    const back = rounds();
    expect(back).toBe(start + 2);

    await act(async () => latest.collapse('f1'));
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS * 2);
    expect(rounds()).toBe(back);

    pages.set('folder:f1', [[file('a1', 'done', 'f1')]]);
    await act(async () => latest.expand('f1'));
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS * 2);
    expect(rounds()).toBe(back);
  });

  it('T15 a run’s material change reads again and keeps the view', async () => {
    await mount();
    await run(() => latest.expand('f1'));
    const before = rounds();
    await run(() =>
      useWorkbenchStore.setState({
        materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
      }),
    );
    expect(rounds()).toBe(before + 1);
    expect(latest.expanded).toEqual(['f1']);
  });

  it('T15b a first-page answer from before a run moved a file out does not land after the change', async () => {
    await mount();
    // The folder's first page is answered from before the move, and only after it.
    const stale = hold((call) => call.kind === 'listing' && inScope('f1')(call.params), {
      ignoreAbort: true,
    });
    await run(() => latest.expand('f1'));
    expect(latest.folder('f1')!.status).toBe('loading');
    // The agent moves a1 out of f1.
    pages.set('folder:f1', [[file('a2', 'done', 'f1')]]);
    pages.set('unfiled', [[file('a1'), file('u1'), file('u2')]]);
    await run(() =>
      useWorkbenchStore.setState({
        materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
      }),
    );
    await stale.open();
    expect(latest.expanded).toEqual(['f1']);
    expect(latest.folder('f1')!.status).toBe('ready');
    expect(ids(latest.folder('f1')!.files)).toEqual(['a2']);
    expect(ids(latest.root.files)).toEqual(['a1', 'u1', 'u2']);
    const shown = [...latest.root.files, ...latest.folder('f1')!.files];
    expect(ids(shown).filter((id) => id === 'a1')).toHaveLength(1);
  });
});

// ── T16–T19: one refresh per return, nothing real swallowed ────────────────

describe('coming back to the page', () => {
  const leave = () =>
    act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
  const comeBack = () =>
    act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });

  it('T16 focus and visibility of one return read once', async () => {
    await mount();
    await setVisibility('hidden');
    const before = rounds();
    const listed = listings().length;
    await comeBack();
    await settle();
    expect(rounds()).toBe(before + 1);
    expect(listings().length).toBe(listed + 1);
  });

  it('T16b a slow refresh, then the teacher leaves and comes back again: a new refresh, whose data stays', async () => {
    await mount();
    await leave();
    const slow = hold((call) => call.kind === 'listing', { ignoreAbort: true });
    await comeBack();
    expect(rounds()).toBe(2);
    pages.set('unfiled', [[file('later')]]);
    await leave();
    await comeBack();
    await settle();
    expect(rounds()).toBe(3);
    expect(ids(latest.root.files)).toEqual(['later']);
    await slow.open();
    expect(ids(latest.root.files)).toEqual(['later']);
  });

  async function wakeRoundInFlight() {
    await mount();
    await leave();
    const slow = hold((call) => call.kind === 'listing', { ignoreAbort: true });
    await comeBack();
    expect(rounds()).toBe(2);
    pages.set('unfiled', [[file('changed')]]);
    return slow;
  }

  it('T17 a write finishing during that refresh still reads again', async () => {
    const slow = await wakeRoundInFlight();
    await run(() => latest.reload());
    expect(rounds()).toBe(3);
    await slow.open();
    expect(ids(latest.root.files)).toEqual(['changed']);
  });

  it('T18 a run’s change during that refresh still reads again', async () => {
    const slow = await wakeRoundInFlight();
    await run(() =>
      useWorkbenchStore.setState({
        materialLibraryRevision: useWorkbenchStore.getState().materialLibraryRevision + 1,
      }),
    );
    expect(rounds()).toBe(3);
    await slow.open();
    expect(ids(latest.root.files)).toEqual(['changed']);
  });

  it('T19 a refresh that began before the teacher came back is followed by one that began after', async () => {
    await mount();
    const slow = hold((call) => call.kind === 'listing', { ignoreAbort: true });
    await run(() => latest.reload()); // a poll or write, before the return
    pages.set('unfiled', [[file('meanwhile')]]);
    await leave();
    await comeBack();
    await settle();
    expect(rounds()).toBe(3);
    expect(ids(latest.root.files)).toEqual(['meanwhile']);
    await slow.open();
    expect(ids(latest.root.files)).toEqual(['meanwhile']);
  });
});

// ── T20: leaving the page ──────────────────────────────────────────────────

describe('leaving the page', () => {
  it('T20 stops its timers, cancels its reads and ignores late answers', async () => {
    pages.set('unfiled', [[file('u1', 'running')]]);
    await mount();
    const slow = hold((call) => call.kind === 'listing', { ignoreAbort: true });
    await run(() => latest.reload());
    const signals = calls.filter((call) => call.signal).map((call) => call.signal!);
    const before = calls.length;
    const seen = latest;
    await act(async () => root!.unmount());
    root = null;
    expect(signals.at(-1)!.aborted).toBe(true);
    await slow.open();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, MATERIAL_LIBRARY_TREE_POLL_MS + 200));
    });
    expect(calls.length).toBe(before);
    expect(latest).toBe(seen);
  }, 10_000);
});

// ── T21–T22: review of R2 ─────────────────────────────────────────────────

describe('what the hidden view and a failed refresh leave behind', () => {
  it('T21 a "load more" of a search left behind does not hold back polling the tree', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    pages.set('unfiled', [[file('u1', 'running')]]);
    pages.set('query:lab', [[file('l1')], [file('l2')]]);
    await act(async () => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      root.render(createElement(Host, { query: 'lab', onValue: report }));
    });
    await tick(0);
    expect(latest.results.hasMore).toBe(true);
    hold((call) => call.kind === 'listing' && call.params.get('before') !== null, {
      ignoreAbort: true,
    });
    await act(async () => latest.loadMore('results'));
    expect(latest.results.loadingMore).toBe(true);

    await act(async () => root!.render(createElement(Host, { query: '', onValue: report })));
    await tick(0);
    expect(latest.mode).toBe('tree');
    expect(latest.results.loadingMore).toBe(false);
    expect(latest.root.files[0].extraction.status).toBe('running');

    pages.set('unfiled', [[file('u1', 'done')]]);
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    expect(latest.root.files[0].extraction.status).toBe('done');
  });

  it('T21b a "load more" of the tree left behind stops, and does not hold back polling the search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    pages.set('unfiled', [[file('u1')], [file('u2')]]);
    pages.set('query:lab', [[file('l1', 'running')]]);
    await act(async () => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      root.render(createElement(Host, { query: '', onValue: report }));
    });
    await tick(0);
    hold((call) => call.kind === 'listing' && call.params.get('before') !== null, {
      ignoreAbort: true,
    });
    await act(async () => latest.loadMore('root'));
    expect(latest.root.loadingMore).toBe(true);
    const signal = listings().at(-1)!.signal!;

    await act(async () => root!.render(createElement(Host, { query: 'lab', onValue: report })));
    await tick(0);
    expect(signal.aborted).toBe(true);
    expect(latest.root.loadingMore).toBe(false);
    expect(latest.results.files[0].extraction.status).toBe('running');

    pages.set('query:lab', [[file('l1', 'done')]]);
    await tick(MATERIAL_LIBRARY_TREE_POLL_MS);
    expect(latest.results.files[0].extraction.status).toBe('done');
    // The stopped page never lands on the tree.
    await act(async () => root!.render(createElement(Host, { query: '', onValue: report })));
    await tick(0);
    expect(ids(latest.root.files)).toEqual(['u1']);
  });

  it('T22 a refresh that fails cancels its other reads, which ask for no further page after unmount', async () => {
    pages.set('unfiled', [[file('u1')], [file('u2')]]);
    await mount();
    await run(() => latest.loadMore('root'));
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);
    const folderRead = hold((call) => call.kind === 'folders');
    const firstPage = hold(
      (call) => call.kind === 'listing' && call.params.get('before') === null,
      { ignoreAbort: true },
    );
    await run(() => latest.reload());
    const signal = listings().at(-1)!.signal!;
    expect(signal.aborted).toBe(false);

    await folderRead.fail(500);
    expect(signal.aborted).toBe(true);
    expect((latest.error as { status?: number }).status).toBe(500);
    expect(latest.refreshing).toBe(false);
    expect(ids(latest.root.files)).toEqual(['u1', 'u2']);

    const before = calls.length;
    await act(async () => root!.unmount());
    root = null;
    await firstPage.open();
    expect(calls.length).toBe(before);
  });
});
