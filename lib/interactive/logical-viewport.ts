import type { ClientBox } from '@/lib/edit/visible-client-rect';

/**
 * The minimum CSS viewport every generated interactive page is authored against.
 * The frame never gets smaller than this; it grows along whichever axis the
 * slot has to spare, so a page always fills its slot.
 */
export const GENUI_LOGICAL_WIDTH = 1280;
export const GENUI_LOGICAL_HEIGHT = 720;

/**
 * Lowest scale, as a fraction of the no-overflow scale, the frame will shrink a
 * page to so its whole content fits without scrolling. Below this text gets too
 * small to read; past it the page keeps this scale and scrolls, with a cue.
 */
export const GENUI_FIT_MIN_SCALE_RATIO = 0.75;

/** Most times one loaded document may enlarge its logical viewport. */
export const GENUI_FIT_MAX_REFITS = 4;

/** Overflow, in logical CSS px, small enough to ignore (rounding, hairline borders). */
export const GENUI_FIT_TOLERANCE = 4;

/** Real extent of a page's content, in logical CSS px, as the page measured it. */
export interface GenUiContentSize {
  readonly width: number;
  readonly height: number;
}

export interface FittedGenUiViewport {
  /** Screen box the scaled frame covers. Always the whole slot. */
  readonly box: ClientBox;
  /** Screen pixels per logical CSS pixel. */
  readonly scale: number;
  /** Logical CSS width of the page's viewport (at least {@link GENUI_LOGICAL_WIDTH}). */
  readonly width: number;
  /** Logical CSS height of the page's viewport (at least {@link GENUI_LOGICAL_HEIGHT}). */
  readonly height: number;
  /** Scale the slot gives with no content overflow (the 1280×720 minimum fully on screen). */
  readonly baseScale: number;
  /** The content asked for more room than the scale floor allows; the page scrolls. */
  readonly atFloor: boolean;
}

/**
 * Fit a GenUI frame to an arbitrary screen slot with no letterboxing.
 *
 * The scale keeps the 1280×720 minimum fully on screen; the logical viewport
 * then takes the slot's own aspect, so one side stays at its minimum and the
 * other grows. When the page reported content larger than that viewport, the
 * scale shrinks until the content fits, but never below
 * {@link GENUI_FIT_MIN_SCALE_RATIO} of the base scale. A slot with no
 * measurable size collapses to scale 0 at the minimum logical size.
 */
export function fitGenUiViewport(
  slot: ClientBox,
  content?: GenUiContentSize | null,
): FittedGenUiViewport {
  const baseScale = Math.max(
    0,
    Math.min(slot.width / GENUI_LOGICAL_WIDTH, slot.height / GENUI_LOGICAL_HEIGHT),
  );
  if (baseScale <= 0) {
    return {
      scale: 0,
      baseScale: 0,
      atFloor: false,
      width: GENUI_LOGICAL_WIDTH,
      height: GENUI_LOGICAL_HEIGHT,
      box: { left: slot.left, top: slot.top, width: 0, height: 0 },
    };
  }
  let scale = baseScale;
  let atFloor = false;
  if (content && content.width > 0 && content.height > 0) {
    const wanted = Math.min(baseScale, slot.width / content.width, slot.height / content.height);
    const floor = baseScale * GENUI_FIT_MIN_SCALE_RATIO;
    atFloor = wanted < floor;
    scale = Math.max(wanted, floor);
  }
  return {
    scale,
    baseScale,
    atFloor,
    width: Math.max(GENUI_LOGICAL_WIDTH, slot.width / scale),
    height: Math.max(GENUI_LOGICAL_HEIGHT, slot.height / scale),
    box: { left: slot.left, top: slot.top, width: slot.width, height: slot.height },
  };
}

/** What the injected fit script posts each time the page's layout settles. */
export interface GenUiContentReport {
  /** The page's own viewport when it measured (`innerWidth`/`innerHeight`). */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Union of the document's scroll size and its rendered element boxes. */
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** How far the page itself can still scroll down, in logical px. */
  readonly scrollRemaining: number;
}

/** Per-document fit state. Reset whenever the document or the slot size changes. */
export interface GenUiFitState {
  /** Content size the frame currently fits to; `null` fits the slot alone. */
  readonly content: GenUiContentSize | null;
  /** How many times this document has enlarged its viewport. */
  readonly refits: number;
  /**
   * Overflow (the larger axis, logical px) that triggered the latest refit,
   * until the page's first report at the new size has been checked against it.
   */
  readonly lastOverflow: number | null;
  /** No further refits: the budget ran out or growing stopped helping. */
  readonly settled: boolean;
}

export const INITIAL_GENUI_FIT_STATE: GenUiFitState = {
  content: null,
  refits: 0,
  lastOverflow: null,
  settled: false,
};

/** Read a fit report out of an untrusted iframe message; `null` when malformed. */
export function parseGenUiContentReport(data: unknown): GenUiContentReport | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.__maicInteractive !== true || d.kind !== 'content-extent') return null;
  const fields = [
    'viewportWidth',
    'viewportHeight',
    'contentWidth',
    'contentHeight',
    'scrollRemaining',
  ] as const;
  for (const field of fields) {
    const value = d[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e6) {
      return null;
    }
  }
  return {
    viewportWidth: d.viewportWidth as number,
    viewportHeight: d.viewportHeight as number,
    contentWidth: d.contentWidth as number,
    contentHeight: d.contentHeight as number,
    scrollRemaining: d.scrollRemaining as number,
  };
}

/**
 * Advance the fit for one page report, given the viewport currently applied.
 *
 * Only grows: the content request never shrinks within a load, so a page whose
 * layout reacts to the new size cannot make the frame oscillate. A layout that
 * grows with its viewport (`height: 110vh`) is caught two ways: when the first
 * report after a refit shows no less overflow, the refit did not help, so the
 * frame reverts to the plain slot fit and settles; and a load gets at most
 * {@link GENUI_FIT_MAX_REFITS} refits in any case. Later reports at the same
 * size are new content (a section the learner opened), not a verdict on the
 * refit, so they may refit again within the budget.
 */
export function reduceGenUiFit(
  state: GenUiFitState,
  report: GenUiContentReport,
  applied: FittedGenUiViewport,
): GenUiFitState {
  if (state.settled || applied.scale <= 0) return state;
  // Measured against a viewport the frame has since replaced: wait for the
  // page's report at the current size.
  if (
    Math.abs(report.viewportWidth - applied.width) > 1.5 ||
    Math.abs(report.viewportHeight - applied.height) > 1.5
  ) {
    return state;
  }
  const overflow = Math.max(
    report.contentWidth - applied.width,
    report.contentHeight - applied.height,
  );
  const pending = state.lastOverflow;
  const checked = pending === null ? state : { ...state, lastOverflow: null };
  if (overflow <= GENUI_FIT_TOLERANCE) return checked;
  if (pending !== null && overflow >= pending - GENUI_FIT_TOLERANCE) {
    return { content: null, refits: state.refits, lastOverflow: null, settled: true };
  }
  if (applied.atFloor || state.refits >= GENUI_FIT_MAX_REFITS) {
    return { ...checked, settled: true };
  }
  return {
    content: {
      width: Math.max(state.content?.width ?? 0, report.contentWidth),
      height: Math.max(state.content?.height ?? 0, report.contentHeight),
    },
    refits: state.refits + 1,
    lastOverflow: overflow,
    settled: false,
  };
}

/** Whether the frame should show its "more below" cue for the latest report. */
export function shouldShowGenUiMoreCue(
  report: GenUiContentReport | null,
  applied: FittedGenUiViewport,
  state: GenUiFitState,
): boolean {
  if (!report || applied.scale <= 0) return false;
  if (
    Math.abs(report.viewportWidth - applied.width) > 1.5 ||
    Math.abs(report.viewportHeight - applied.height) > 1.5
  ) {
    return false;
  }
  if (report.scrollRemaining <= GENUI_FIT_TOLERANCE * 2) return false;
  return applied.atFloor || state.settled;
}
