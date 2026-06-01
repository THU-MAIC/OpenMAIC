/**
 * Keep-alive pool for interactive scene iframes (#619).
 *
 * Interactive scenes render their content in an `<iframe>`. When that element
 * unmounts or is re-parented (Pro mode toggle, scene switch and back, any
 * PlaybackChromeRoot remount) the browser drops the document and re-parses /
 * re-runs from scratch, losing in-iframe state. To avoid that, the actual
 * iframe elements live in a single stable host (`InteractiveIframeHost`)
 * mounted at the `Stage` root, outside the reconciled scene subtree. This store
 * is the coordination layer between the in-tree placeholder (`InteractiveRenderer`)
 * and that host: it tracks, per scene, the content to render, the live on-screen
 * rect to position the iframe over, and whether it should currently be visible.
 *
 * Entries are keyed by sceneId and persist across scene/mode changes — a scene's
 * iframe is only rebuilt when its content actually changes. A small LRU cap
 * bounds how many documents stay resident in memory.
 */

import { create } from 'zustand';

export const IFRAME_POOL_CAP = 3;

export interface IframeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface IframePoolEntry {
  /** Patched HTML for `srcDoc`, when the scene carries inline HTML. */
  readonly srcDoc?: string;
  /** URL for `src`, when the scene points at an external page. */
  readonly src?: string;
  /** Live screen rect the host positions the iframe over, or null until measured. */
  readonly rect: IframeRect | null;
  /** Whether the iframe should currently be shown (placeholder mounted & active). */
  readonly visible: boolean;
  /** Monotonic recency marker for LRU eviction. */
  readonly tick: number;
}

interface MountInput {
  readonly srcDoc?: string;
  readonly src?: string;
}

interface InteractiveIframePoolState {
  entries: Record<string, IframePoolEntry>;
  activeSceneId: string | null;
  /** Monotonic counter; each mount/touch takes the next value. */
  tick: number;
  mount: (sceneId: string, input: MountInput) => void;
  setRect: (sceneId: string, rect: IframeRect) => void;
  show: (sceneId: string) => void;
  hide: (sceneId: string) => void;
  setActive: (sceneId: string) => void;
  evict: (sceneId: string) => void;
  /** Drop everything (e.g. when the host unmounts on classroom switch). */
  reset: () => void;
}

/**
 * Drop the least-recently-touched entries until at most CAP remain. The active
 * scene is never evicted (its iframe is on screen). Returns a new entries map.
 */
function evictLru(
  entries: Record<string, IframePoolEntry>,
  activeSceneId: string | null,
): Record<string, IframePoolEntry> {
  const ids = Object.keys(entries);
  if (ids.length <= IFRAME_POOL_CAP) return entries;
  const evictable = ids
    .filter((id) => id !== activeSceneId)
    .sort((a, b) => entries[a].tick - entries[b].tick);
  const next = { ...entries };
  let overflow = ids.length - IFRAME_POOL_CAP;
  for (const id of evictable) {
    if (overflow <= 0) break;
    delete next[id];
    overflow--;
  }
  return next;
}

export const useInteractiveIframePool = create<InteractiveIframePoolState>((set) => ({
  entries: {},
  activeSceneId: null,
  tick: 0,

  mount: (sceneId, input) =>
    set((state) => {
      const tick = state.tick + 1;
      const existing = state.entries[sceneId];
      // Same content already loaded: just refresh recency. Crucially we keep the
      // existing srcDoc/src reference so the host never re-sets it (which would
      // reload the iframe). String `===` is by value, so a remount that produces
      // an equal-but-new srcDoc string still hits this keep-alive fast path.
      if (existing && existing.srcDoc === input.srcDoc && existing.src === input.src) {
        const entries = { ...state.entries, [sceneId]: { ...existing, tick } };
        return { entries, tick };
      }
      // New scene, or content changed: (re)build the entry. A content change here
      // is the one intended reload path.
      const entry: IframePoolEntry = {
        srcDoc: input.srcDoc,
        src: input.src,
        rect: existing?.rect ?? null,
        visible: existing?.visible ?? false,
        tick,
      };
      const entries = evictLru({ ...state.entries, [sceneId]: entry }, state.activeSceneId);
      return { entries, tick };
    }),

  setRect: (sceneId, rect) =>
    set((state) => {
      const existing = state.entries[sceneId];
      if (!existing) return {};
      const r = existing.rect;
      if (
        r &&
        r.left === rect.left &&
        r.top === rect.top &&
        r.width === rect.width &&
        r.height === rect.height
      ) {
        return {};
      }
      return { entries: { ...state.entries, [sceneId]: { ...existing, rect } } };
    }),

  show: (sceneId) =>
    set((state) => {
      const existing = state.entries[sceneId];
      if (!existing || existing.visible) return {};
      return { entries: { ...state.entries, [sceneId]: { ...existing, visible: true } } };
    }),

  hide: (sceneId) =>
    set((state) => {
      const existing = state.entries[sceneId];
      if (!existing || !existing.visible) return {};
      return { entries: { ...state.entries, [sceneId]: { ...existing, visible: false } } };
    }),

  setActive: (sceneId) => set({ activeSceneId: sceneId }),

  evict: (sceneId) =>
    set((state) => {
      if (!state.entries[sceneId]) return {};
      const entries = { ...state.entries };
      delete entries[sceneId];
      const activeSceneId = state.activeSceneId === sceneId ? null : state.activeSceneId;
      return { entries, activeSceneId };
    }),

  reset: () => set({ entries: {}, activeSceneId: null, tick: 0 }),
}));
