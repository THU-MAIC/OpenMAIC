import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ClientBox } from '@/lib/edit/visible-client-rect';
import {
  INITIAL_GENUI_FIT_STATE,
  fitGenUiViewport,
  parseGenUiContentReport,
  reduceGenUiFit,
  shouldShowGenUiMoreCue,
  type FittedGenUiViewport,
  type GenUiContentReport,
  type GenUiFitState,
} from './logical-viewport';

interface FitStore {
  readonly key: string;
  readonly fit: GenUiFitState;
  readonly report: GenUiContentReport | null;
}

/**
 * State is keyed by the document and the slot's plain logical viewport, not
 * its pixel size: slots of the same aspect (a pane animating to full screen)
 * give the page the same viewport, so the page has nothing new to report and
 * its fit must carry over.
 */
function fitKey(slot: ClientBox | null, documentKey: string): string {
  const base = slot ? fitGenUiViewport(slot) : null;
  const size = base && base.scale > 0 ? `${Math.round(base.width)}x${Math.round(base.height)}` : '';
  return `${size}\n${documentKey}`;
}

/** Message the host sends once it listens, so the page re-posts its extent. */
export const GENUI_FIT_REPORT_REQUEST = { __maicFitReportRequest: true } as const;
/** Message the "more below" cue sends to scroll the page by most of a screen. */
export const GENUI_FIT_SCROLL_REQUEST = { __maicFitScrollBy: true } as const;

/**
 * Fit a GenUI frame to its slot and to the content its page reports.
 *
 * State belongs to one document at one slot size: a new document, or a slot of
 * a different size, starts again from the plain slot fit, so the refit budget
 * is per load and per layout. `handleMessage` consumes the page's
 * `content-extent` reports (returning `true` when it did) and the caller routes
 * every message from its own frame through it.
 */
export function useGenUiFit(
  slot: ClientBox | null,
  documentKey: string,
): {
  readonly viewport: FittedGenUiViewport | null;
  readonly showMoreCue: boolean;
  readonly handleMessage: (data: unknown) => boolean;
  /** Changes whenever the fit starts over; ask the page for a fresh report then. */
  readonly fitKey: string;
} {
  const key = fitKey(slot, documentKey);
  const [store, setStore] = useState<FitStore>(() => ({
    key,
    fit: INITIAL_GENUI_FIT_STATE,
    report: null,
  }));
  const current: FitStore =
    store.key === key ? store : { key, fit: INITIAL_GENUI_FIT_STATE, report: null };
  const viewport = slot ? fitGenUiViewport(slot, current.fit.content) : null;

  const latest = useRef<{ key: string; slot: ClientBox | null }>({ key, slot });
  useLayoutEffect(() => {
    latest.current = { key, slot };
  }, [key, slot]);

  const handleMessage = useCallback((data: unknown): boolean => {
    const report = parseGenUiContentReport(data);
    if (!report) return false;
    const { key: liveKey, slot: liveSlot } = latest.current;
    if (!liveSlot) return true;
    setStore((prev) => {
      const base: FitStore =
        prev.key === liveKey ? prev : { key: liveKey, fit: INITIAL_GENUI_FIT_STATE, report: null };
      const applied = fitGenUiViewport(liveSlot, base.fit.content);
      return { key: liveKey, fit: reduceGenUiFit(base.fit, report, applied), report };
    });
    return true;
  }, []);

  return {
    viewport,
    showMoreCue: viewport ? shouldShowGenUiMoreCue(current.report, viewport, current.fit) : false,
    handleMessage,
    fitKey: key,
  };
}
