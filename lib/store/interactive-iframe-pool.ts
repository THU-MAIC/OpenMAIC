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
import { readNetworkQuality } from '@/lib/utils/network-quality';

export const IFRAME_POOL_CAP = 3;

/**
 * On a slow / data-saver link, shrink the pool to ONE resident document.
 *
 * Each interactive scene's iframe loads heavy third-party libraries (KaTeX, and
 * the simulator scenes pull Pyodide + the multi-MB `python_stdlib.zip`) from a
 * CDN at view time. With the normal 3-document pool, walking slides 2→3→4 leaves
 * the previous slides' iframes still mid-download; on weak 3G/4G those multi-MB
 * fetches never finish and saturate the single connection, so even the active
 * slide can't get its own resources through and renders blank while the
 * (locally-cached) TTS audio plays. Holding only the active iframe gives it the
 * full pipe; the once-downloaded libraries are then HTTP-cached, so the next
 * simulator slide is fast. Keep-alive (instant return without reload) is the
 * cost — an acceptable trade on a link where the priority is the slide loading
 * at all. Fast links keep the full pool.
 */
export const SLOW_LINK_IFRAME_POOL_CAP = 1;

/**
 * Resolve the live pool cap from current network quality. Conservative: only
 * shrinks on positive evidence of a slow/Save-Data link; when the Network
 * Information API is unavailable (Safari/Firefox → `unknown`) it stays at the
 * full cap, so we never degrade keep-alive on links we can't measure.
 */
export function getActiveIframePoolCap(): number {
  return readNetworkQuality().isDataSaver ? SLOW_LINK_IFRAME_POOL_CAP : IFRAME_POOL_CAP;
}

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
  /**
   * Id of the placeholder instance that currently owns visibility, or null when
   * no placeholder is mounted. The iframe shows iff this is non-null. Ownership
   * (rather than a bare boolean) is what makes `release` race-safe: during the
   * Stage mode cross-fade an outgoing placeholder's unmount cleanup can run
   * *after* a newer placeholder for the same scene has already mounted and
   * claimed it — keying the release on the owner id lets the stale cleanup
   * no-op instead of hiding the live iframe.
   */
  readonly owner: string | null;
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
  /** A placeholder claims visibility for its scene, recording its owner id. */
  claim: (sceneId: string, owner: string) => void;
  /** Release visibility, but only if `owner` still owns it (stale = no-op). */
  release: (sceneId: string, owner: string) => void;
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
  cap: number,
): Record<string, IframePoolEntry> {
  const ids = Object.keys(entries);
  if (ids.length <= cap) return entries;
  const evictable = ids
    .filter((id) => id !== activeSceneId)
    .sort((a, b) => entries[a].tick - entries[b].tick);
  const next = { ...entries };
  let overflow = ids.length - cap;
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
        owner: existing?.owner ?? null,
        tick,
      };
      const entries = evictLru(
        { ...state.entries, [sceneId]: entry },
        state.activeSceneId,
        getActiveIframePoolCap(),
      );
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

  claim: (sceneId, owner) =>
    set((state) => {
      const existing = state.entries[sceneId];
      if (!existing || existing.owner === owner) return {};
      return { entries: { ...state.entries, [sceneId]: { ...existing, owner } } };
    }),

  release: (sceneId, owner) =>
    set((state) => {
      const existing = state.entries[sceneId];
      // Only the current owner may release. A stale placeholder (whose unmount
      // cleanup runs after a newer one already re-claimed during the mode
      // cross-fade) finds owner !== its id and no-ops, so the live iframe stays.
      if (!existing || existing.owner !== owner) return {};
      return { entries: { ...state.entries, [sceneId]: { ...existing, owner: null } } };
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
