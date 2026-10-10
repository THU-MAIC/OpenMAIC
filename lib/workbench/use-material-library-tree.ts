'use client';

/**
 * The knowledge base as one file-manager list (RFC #1716 §7, #1835 review):
 * folders and the files in no folder at the top, a folder's files read only
 * once the teacher expands it, one level deep; with a query, one flat list of
 * results across folders.
 *
 * - **Pages per node.** The top level, each expanded folder and the results
 *   page on their own, each from its own cursor. Collapsing a folder drops
 *   its pages; expanding it again reads from the first page.
 * - **A refresh reads what is shown, then swaps it at once.** The folders,
 *   and as many pages as each shown node has (each page from the cursor the
 *   same refresh's previous page returned, stopping where a node ends now).
 *   Nothing shown turns back into "loading" meanwhile, and a failure keeps
 *   what is shown. A folder still reading its first page is read again
 *   too, superseding that read; a folder deleted elsewhere leaves the tree.
 * - **The teacher's view is theirs.** A refresh never changes which folders
 *   are expanded or the query. A read is honoured only by the node it was
 *   for: collapsing, expanding again, a new query or a refresh starting
 *   supersedes the reads before it (a refresh also cancels a "load more" in
 *   flight, and "load more" waits while a refresh runs). Switching between
 *   the tree and a search stops the hidden view's "load more", so nothing
 *   hidden holds back the polling of what is shown.
 * - **Option B freshness (§7).** After the page's own writes (`reload`), when
 *   a run reports a material change, on focus or when the tab becomes
 *   visible, and every few seconds while the tab is visible and an upload of
 *   the page or a shown file is still pending. Each of these starts a new
 *   refresh that supersedes the one running -- except a focus or visibility
 *   event of the same return to the page: once a refresh started because the
 *   teacher came back, the other event of that return adds nothing.
 * - **Usage.** One listing read per refresh carries the limits and usage
 *   (the first page of the top level, or of the results); every other read
 *   says `limits=0`.
 *
 * Leaving the page stops its timers, cancels the reads it can and ignores
 * any answer that still arrives. A refresh that fails cancels its other
 * reads at once, and a cancelled refresh asks for no further page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import {
  fetchMaterialLibraryFolders,
  fetchMaterialLibraryPage,
  joinLibraryPages,
  type LibraryFolder,
  type LibraryLimits,
  type LibraryMaterial,
  type LibraryScope,
} from '@/lib/workbench/material-library-client';

/** How long after a refresh the list is read again while something is pending. */
export const MATERIAL_LIBRARY_TREE_POLL_MS = 3_000;

/** A node of the list: the top level, one expanded folder, or the results. */
export type LibraryNodeKey = 'root' | 'results' | { readonly folderId: string };

export interface LibraryNodeView {
  readonly files: readonly LibraryMaterial[];
  /** `loading` / `error`: its first page has not answered, or failed. */
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: unknown;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
}

export interface MaterialLibraryTree {
  /** `search` while the query is not blank. */
  readonly mode: 'tree' | 'search';
  readonly folders: readonly LibraryFolder[];
  readonly limits: LibraryLimits | null;
  /** The files in no folder. */
  readonly root: LibraryNodeView;
  /** The flat results of the query. */
  readonly results: LibraryNodeView;
  /** The expanded folders, in the order they were opened. */
  readonly expanded: readonly string[];
  /** An expanded folder's files, or null when it is not expanded. */
  readonly folder: (folderId: string) => LibraryNodeView | null;
  /** A refresh is reading what is shown; "load more" waits for it. */
  readonly refreshing: boolean;
  /** Why the latest read failed, whether or not data is still shown. */
  readonly error: unknown;
  readonly expand: (folderId: string) => void;
  readonly collapse: (folderId: string) => void;
  readonly loadMore: (node: LibraryNodeKey) => void;
  /** Read what is shown again; retryOnError keeps an accepted write awaiting a successful read. */
  readonly reload: (options?: { readonly retryOnError?: boolean }) => void;
}

interface Node {
  readonly files: readonly LibraryMaterial[];
  /** Pages shown, which a refresh reads again. */
  readonly pages: number;
  readonly nextBefore: string | undefined;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: unknown;
  readonly loadingMore: boolean;
}

interface State {
  readonly folders: readonly LibraryFolder[];
  readonly limits: LibraryLimits | null;
  readonly root: Node;
  readonly results: Node;
  /** Map order is the order the folders were expanded in. */
  readonly expanded: ReadonlyMap<string, Node>;
  readonly refreshing: boolean;
  readonly error: unknown;
}

const EMPTY_NODE: Node = {
  files: [],
  pages: 0,
  nextBefore: undefined,
  status: 'loading',
  error: null,
  loadingMore: false,
};

const keyOf = (node: LibraryNodeKey): string =>
  typeof node === 'string' ? node : `folder:${node.folderId}`;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

const pending = (node: Node) =>
  node.files.some(
    (file) => file.extraction.status === 'pending' || file.extraction.status === 'running',
  );

function view(node: Node): LibraryNodeView {
  return {
    files: node.files,
    status: node.status,
    error: node.error,
    hasMore: node.nextBefore !== undefined,
    loadingMore: node.loadingMore,
  };
}

/** One node of a refresh: what it reads and the read it holds. */
interface Target {
  readonly key: string;
  readonly folderId: string | null;
  readonly scope: LibraryScope;
  readonly pages: number;
  /** This read carries the limits and usage. */
  readonly withLimits: boolean;
  readonly ticket: number;
}

export function useMaterialLibraryTree(input: {
  readonly query: string;
  /** The page has uploads in flight (the listing never shows those). */
  readonly uploading?: boolean;
}): MaterialLibraryTree {
  const query = input.query.trim();
  const mode: 'tree' | 'search' = query ? 'search' : 'tree';
  const queryRef = useRef(query);

  const [state, setState] = useState<State>(() => ({
    folders: [],
    limits: null,
    root: EMPTY_NODE,
    results: EMPTY_NODE,
    expanded: new Map(),
    refreshing: true,
    error: null,
  }));
  /** The state as last committed, for decisions made between renders. */
  const current = useRef(state);
  const alive = useRef(false);
  const commit = useCallback((change: (state: State) => State) => {
    if (!alive.current) return;
    const next = change(current.current);
    if (next === current.current) return;
    current.current = next;
    setState(next);
  }, []);

  /**
   * Which read each node honours. A read keeps the ticket it was given and
   * commits only while its node still holds that ticket; collapsing drops
   * the node's ticket, so nothing before it can land on a later expansion.
   */
  const tickets = useRef(new Map<string, number>());
  const ticketSeq = useRef(0);
  const issue = (key: string) => {
    const ticket = ++ticketSeq.current;
    tickets.current.set(key, ticket);
    return ticket;
  };
  const holds = (key: string, ticket: number) => tickets.current.get(key) === ticket;
  /** The cancellable read of a node outside a refresh (first page, load more). */
  const nodeReads = useRef(new Map<string, AbortController>());
  const cancelNodeRead = (key: string) => {
    nodeReads.current.get(key)?.abort();
    nodeReads.current.delete(key);
  };

  /** Times the teacher left the page (blur, hidden): one return is one wake. */
  const away = useRef(0);
  const round = useRef<{
    readonly id: number;
    readonly abort: AbortController;
    readonly wake: boolean;
    readonly awayAtStart: number;
  } | null>(null);
  const roundSeq = useRef(0);
  // An accepted parse may still look idle/failed until its first refresh succeeds.
  // Keep that invalidation through read failures; do not invent a parsing status.
  const refreshRequired = useRef(false);

  const refresh = useCallback(
    (cause: 'wake' | 'other') => {
      if (!alive.current) return;
      round.current?.abort.abort();
      const id = ++roundSeq.current;
      const abort = new AbortController();
      round.current = { id, abort, wake: cause === 'wake', awayAtStart: away.current };

      const shown = current.current;
      const searching = queryRef.current !== '';
      const roundQuery = queryRef.current;
      const targets: Target[] = [];
      const take = (
        key: string,
        folderId: string | null,
        scope: LibraryScope,
        node: Node,
        withLimits: boolean,
      ) => {
        cancelNodeRead(key);
        targets.push({
          key,
          folderId,
          scope,
          pages: Math.max(1, node.pages),
          withLimits,
          ticket: issue(key),
        });
      };
      if (searching) {
        take('results', null, { kind: 'all' }, shown.results, true);
      } else {
        take('root', null, { kind: 'unfiled' }, shown.root, true);
        for (const [folderId, node] of shown.expanded) {
          // A first page still being read is read again too: its answer may
          // predate what made this refresh start.
          take(keyOf({ folderId }), folderId, { kind: 'folder', folderId }, node, false);
        }
      }
      const isTarget = new Map(targets.map((target) => [target.key, target]));
      const settleNode = (key: string, node: Node, change: (node: Node) => Node) => {
        const target = isTarget.get(key);
        return target && holds(key, target.ticket) ? change(node) : node;
      };
      commit((state) => ({
        ...state,
        refreshing: true,
        // A "load more" this refresh superseded has stopped.
        root: settleNode('root', state.root, (node) => ({ ...node, loadingMore: false })),
        results: settleNode('results', state.results, (node) => ({ ...node, loadingMore: false })),
        expanded: new Map(
          [...state.expanded].map(([folderId, node]) => [
            folderId,
            settleNode(keyOf({ folderId }), node, (n) => ({ ...n, loadingMore: false })),
          ]),
        ),
      }));

      const readTarget = async (target: Target) => {
        const pages: (readonly LibraryMaterial[])[] = [];
        let limits: LibraryLimits | undefined;
        let before: string | undefined;
        for (let index = 0; index < target.pages; index += 1) {
          // Cancelled or superseded meanwhile (a page may still have
          // answered): ask for no further page.
          if (abort.signal.aborted) throw new DOMException('superseded', 'AbortError');
          const page = await fetchMaterialLibraryPage({
            scope: target.scope,
            query: target.scope.kind === 'all' ? roundQuery : '',
            ...(before ? { before } : {}),
            withLimits: target.withLimits && index === 0,
            signal: abort.signal,
          });
          pages.push(page.materials);
          if (index === 0) limits = page.limits;
          before = page.nextBefore;
          // The node ends here now: no older cursor, no padding to the old count.
          if (!before) break;
        }
        return { target, pages, limits, nextBefore: before };
      };

      void Promise.all([fetchMaterialLibraryFolders(abort.signal), ...targets.map(readTarget)])
        .then(([folders, ...reads]) => {
          if (round.current?.id !== id) return;
          round.current = null;
          refreshRequired.current = false;
          const live = new Set(folders.map((folder) => folder.id));
          const read = new Map(reads.map((entry) => [entry.target.key, entry]));
          const fresh = (key: string, node: Node): Node => {
            const entry = read.get(key);
            if (!entry || !holds(key, entry.target.ticket)) return node;
            return {
              files: joinLibraryPages(entry.pages),
              pages: entry.pages.length,
              nextBefore: entry.nextBefore,
              status: 'ready',
              error: null,
              loadingMore: false,
            };
          };
          const limits = reads.find((entry) => entry.target.withLimits)?.limits;
          commit((state) => {
            const expanded = new Map<string, Node>();
            for (const [folderId, node] of state.expanded) {
              const key = keyOf({ folderId });
              // Deleted elsewhere: it leaves the tree; the others stay open.
              if (!live.has(folderId)) {
                tickets.current.delete(key);
                cancelNodeRead(key);
                continue;
              }
              expanded.set(folderId, fresh(key, node));
            }
            return {
              folders,
              limits: limits ?? state.limits,
              root: fresh('root', state.root),
              results: fresh('results', state.results),
              expanded,
              refreshing: false,
              error: null,
            };
          });
        })
        .catch((error: unknown) => {
          if (round.current?.id !== id || isAbort(error)) return;
          // One read failed: the refresh is over, so its other reads stop
          // too -- this is the last moment anything can still cancel them.
          abort.abort();
          round.current = null;
          // What is shown stays; a node with nothing to show says it failed.
          const failed = (key: string, node: Node) =>
            settleNode(key, node, (n) => (n.pages === 0 ? { ...n, status: 'error', error } : n));
          commit((state) => ({
            ...state,
            root: failed('root', state.root),
            results: failed('results', state.results),
            expanded: new Map(
              [...state.expanded].map(([folderId, node]) => [
                folderId,
                failed(keyOf({ folderId }), node),
              ]),
            ),
            refreshing: false,
            error,
          }));
        });
    },
    [commit],
  );

  /** Read one page into a node outside a refresh: its first, or the next. */
  const readNodePage = useCallback(
    (
      key: string,
      scope: LibraryScope,
      before: string | undefined,
      apply: (node: Node, page: { files: readonly LibraryMaterial[]; nextBefore?: string }) => Node,
      fail: (node: Node, error: unknown) => Node,
      update: (state: State, change: (node: Node) => Node) => State,
    ) => {
      cancelNodeRead(key);
      const ticket = issue(key);
      const abort = new AbortController();
      nodeReads.current.set(key, abort);
      void fetchMaterialLibraryPage({
        scope,
        query: scope.kind === 'all' ? queryRef.current : '',
        ...(before ? { before } : {}),
        withLimits: false,
        signal: abort.signal,
      }).then(
        (page) => {
          if (!holds(key, ticket)) return;
          nodeReads.current.delete(key);
          commit((state) =>
            update(state, (node) =>
              apply(node, { files: page.materials, nextBefore: page.nextBefore }),
            ),
          );
        },
        (error: unknown) => {
          if (!holds(key, ticket) || isAbort(error)) return;
          nodeReads.current.delete(key);
          commit((state) => ({ ...update(state, (node) => fail(node, error)), error }));
        },
      );
    },
    [commit],
  );

  const updateFolder =
    (folderId: string) =>
    (state: State, change: (node: Node) => Node): State => {
      const node = state.expanded.get(folderId);
      if (!node) return state;
      const expanded = new Map(state.expanded);
      expanded.set(folderId, change(node));
      return { ...state, expanded };
    };

  const expand = useCallback(
    (folderId: string) => {
      if (current.current.expanded.has(folderId)) return;
      commit((state) => {
        const expanded = new Map(state.expanded);
        expanded.set(folderId, EMPTY_NODE);
        return { ...state, expanded };
      });
      readNodePage(
        keyOf({ folderId }),
        { kind: 'folder', folderId },
        undefined,
        (_node, page) => ({
          files: joinLibraryPages([page.files]),
          pages: 1,
          nextBefore: page.nextBefore,
          status: 'ready',
          error: null,
          loadingMore: false,
        }),
        (node, error) => ({ ...node, status: 'error', error }),
        updateFolder(folderId),
      );
    },
    [commit, readNodePage],
  );

  const collapse = useCallback(
    (folderId: string) => {
      const key = keyOf({ folderId });
      tickets.current.delete(key);
      cancelNodeRead(key);
      commit((state) => {
        if (!state.expanded.has(folderId)) return state;
        const expanded = new Map(state.expanded);
        expanded.delete(folderId);
        return { ...state, expanded };
      });
    },
    [commit],
  );

  const loadMore = useCallback(
    (target: LibraryNodeKey) => {
      // A refresh is rereading what is shown: a page from the old cursor
      // would not belong to what it brings.
      if (round.current) return;
      const state = current.current;
      const key = keyOf(target);
      const node =
        target === 'root'
          ? state.root
          : target === 'results'
            ? state.results
            : state.expanded.get(target.folderId);
      if (!node || node.loadingMore || node.nextBefore === undefined) return;
      const update =
        target === 'root'
          ? (s: State, change: (node: Node) => Node) => ({ ...s, root: change(s.root) })
          : target === 'results'
            ? (s: State, change: (node: Node) => Node) => ({ ...s, results: change(s.results) })
            : updateFolder(target.folderId);
      const scope: LibraryScope =
        target === 'root'
          ? { kind: 'unfiled' }
          : target === 'results'
            ? { kind: 'all' }
            : { kind: 'folder', folderId: target.folderId };
      commit((s) => update(s, (n) => ({ ...n, loadingMore: true })));
      readNodePage(
        key,
        scope,
        node.nextBefore,
        (n, page) => ({
          ...n,
          files: joinLibraryPages([n.files, page.files]),
          pages: n.pages + 1,
          nextBefore: page.nextBefore,
          loadingMore: false,
        }),
        (n) => ({ ...n, loadingMore: false }),
        update,
      );
    },
    [commit, readNodePage],
  );

  const reload = useCallback(
    (options?: { readonly retryOnError?: boolean }) => {
      if (options?.retryOnError) refreshRequired.current = true;
      refresh('other');
    },
    [refresh],
  );

  // Mounted: reads may commit. Leaving cancels what can be cancelled and
  // ignores the rest.
  useEffect(() => {
    alive.current = true;
    const reads = nodeReads.current;
    const held = tickets.current;
    return () => {
      alive.current = false;
      refreshRequired.current = false;
      round.current?.abort.abort();
      round.current = null;
      for (const abort of reads.values()) abort.abort();
      reads.clear();
      held.clear();
    };
  }, []);

  // A new query, or back to the tree: read from the top. The tree keeps
  // its expanded folders across a search; the results start over. Whatever
  // the switch hides stops reading: the results go entirely on the way back
  // to the tree, and a "load more" of the tree stops on the way into a
  // search (the tree is read again when it is shown again; a folder still
  // reading its first page keeps that read).
  useEffect(() => {
    queryRef.current = query;
    tickets.current.delete('results');
    cancelNodeRead('results');
    const stopMore = (key: string, node: Node): Node => {
      if (!query || !node.loadingMore) return node;
      tickets.current.delete(key);
      cancelNodeRead(key);
      return { ...node, loadingMore: false };
    };
    commit((state) => ({
      ...state,
      results: EMPTY_NODE,
      root: stopMore('root', state.root),
      expanded: new Map(
        [...state.expanded].map(([folderId, node]) => [
          folderId,
          stopMore(keyOf({ folderId }), node),
        ]),
      ),
    }));
    refresh('other');
  }, [query, refresh, commit]);

  // ── Option B: focus, visibility, in-run changes, polling ─────────────
  const [visible, setVisible] = useState(tabVisible);
  useEffect(() => {
    const wake = () => {
      const running = round.current;
      // The other event of the same return: the refresh it started already
      // began after the teacher came back.
      if (running?.wake && running.awayAtStart === away.current) return;
      refresh('wake');
    };
    const leave = () => {
      away.current += 1;
    };
    const onVisibility = () => {
      const now = tabVisible();
      setVisible(now);
      if (now) wake();
      else leave();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', wake);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // A run changed the library: what is shown may predate it.
  const revision = useWorkbenchStore((s) => s.materialLibraryRevision);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    refresh('other');
  }, [revision, refresh]);

  const shownPending =
    input.uploading === true ||
    (mode === 'search'
      ? pending(state.results)
      : pending(state.root) || [...state.expanded.values()].some(pending));
  // Only what is shown: a read of the hidden view never holds the poll back.
  const shownLoadingMore =
    mode === 'search'
      ? state.results.loadingMore
      : state.root.loadingMore || [...state.expanded.values()].some((node) => node.loadingMore);
  // One timer per settled state, none while a read of the list runs, so
  // polls never overlap. A failed refresh schedules the next one too: a
  // failure does not mean the parsing finished.
  useEffect(() => {
    if (
      (!shownPending && !refreshRequired.current) ||
      !visible ||
      state.refreshing ||
      shownLoadingMore
    )
      return;
    const timer = setTimeout(() => refresh('other'), MATERIAL_LIBRARY_TREE_POLL_MS);
    return () => clearTimeout(timer);
  }, [shownPending, visible, state, shownLoadingMore, refresh]);

  return useMemo(() => {
    const expandedViews = new Map(
      [...state.expanded].map(([folderId, node]) => [folderId, view(node)]),
    );
    return {
      mode,
      folders: state.folders,
      limits: state.limits,
      root: view(state.root),
      results: view(state.results),
      expanded: [...state.expanded.keys()],
      folder: (folderId: string) => expandedViews.get(folderId) ?? null,
      refreshing: state.refreshing,
      error: state.error,
      expand,
      collapse,
      loadMore,
      reload,
    };
  }, [state, mode, expand, collapse, loadMore, reload]);
}
