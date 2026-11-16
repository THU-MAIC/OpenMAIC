import { describe, expect, it } from 'vitest';
import {
  GENUI_FIT_MAX_REFITS,
  GENUI_FIT_MIN_SCALE_RATIO,
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  INITIAL_GENUI_FIT_STATE,
  fitGenUiViewport,
  parseGenUiContentReport,
  reduceGenUiFit,
  shouldShowGenUiMoreCue,
  type GenUiContentReport,
  type GenUiFitState,
} from '@/lib/interactive/logical-viewport';

describe('GenUI logical viewport', () => {
  it('keeps the 1280×720 minimum for an exact 16:9 slot', () => {
    expect([GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT]).toEqual([1280, 720]);
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      baseScale: 1,
      atFloor: false,
      width: 1280,
      height: 720,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1920, height: 1080 })).toEqual({
      scale: 1.5,
      baseScale: 1.5,
      atFloor: false,
      width: 1280,
      height: 720,
      box: { left: 0, top: 0, width: 1920, height: 1080 },
    });
  });

  it('grows the logical height to fill a slot taller than 16:9, with no bands', () => {
    const fitted = fitGenUiViewport({ left: 10, top: 20, width: 1190, height: 1025 });
    expect(fitted.scale).toBeCloseTo(1190 / 1280);
    expect(fitted.width).toBe(1280);
    expect(fitted.height).toBeCloseTo(1025 / (1190 / 1280));
    expect(fitted.height).toBeGreaterThan(720);
    expect(fitted.box).toEqual({ left: 10, top: 20, width: 1190, height: 1025 });
    expect(fitted.width * fitted.scale).toBeCloseTo(1190);
    expect(fitted.height * fitted.scale).toBeCloseTo(1025);
  });

  it('grows the logical width to fill a slot wider than 16:9', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 2000, height: 720 })).toEqual({
      scale: 1,
      baseScale: 1,
      atFloor: false,
      width: 2000,
      height: 720,
      box: { left: 0, top: 0, width: 2000, height: 720 },
    });
  });

  it('never drops below the minimum when the slot is smaller than 1280×720', () => {
    const fitted = fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 });
    expect(fitted.scale).toBe(0.5);
    expect(fitted.width).toBe(1280);
    expect(fitted.height).toBe(1000);
    expect(fitted.box).toEqual({ left: 10, top: 20, width: 640, height: 500 });
    for (const slot of [
      { width: 333, height: 777 },
      { width: 1001, height: 99 },
      { width: 1191.3, height: 1024.7 },
    ]) {
      const f = fitGenUiViewport({ left: 0, top: 0, ...slot });
      expect(f.width).toBeGreaterThanOrEqual(GENUI_LOGICAL_WIDTH);
      expect(f.height).toBeGreaterThanOrEqual(GENUI_LOGICAL_HEIGHT);
      expect(Math.min(f.width - GENUI_LOGICAL_WIDTH, f.height - GENUI_LOGICAL_HEIGHT)).toBeCloseTo(
        0,
      );
    }
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 0,
      baseScale: 0,
      atFloor: false,
      width: 1280,
      height: 720,
      box: { left: 7, top: 9, width: 0, height: 0 },
    });
  });
});

const SLOT = { left: 0, top: 0, width: 1280, height: 720 };

function reportAt(
  viewport: { width: number; height: number },
  content: { width: number; height: number },
  scrollRemaining = 0,
): GenUiContentReport {
  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    contentWidth: content.width,
    contentHeight: content.height,
    scrollRemaining,
  };
}

describe('GenUI fit to content', () => {
  it('leaves a page that fits at the plain slot fit', () => {
    const applied = fitGenUiViewport(SLOT);
    const next = reduceGenUiFit(
      INITIAL_GENUI_FIT_STATE,
      reportAt(applied, { width: 1280, height: 722 }),
      applied,
    );
    expect(next).toBe(INITIAL_GENUI_FIT_STATE);
  });

  it('shrinks the scale so taller content fits, keeping the slot aspect', () => {
    const fitted = fitGenUiViewport(SLOT, { width: 1280, height: 900 });
    expect(fitted.scale).toBeCloseTo(720 / 900);
    expect(fitted.height).toBeCloseTo(900);
    expect(fitted.width).toBeCloseTo(1600);
    expect(fitted.width * fitted.scale).toBeCloseTo(1280);
    expect(fitted.atFloor).toBe(false);
    expect(fitted.box).toEqual(SLOT);
  });

  it('fits content that spills off the right edge too', () => {
    const fitted = fitGenUiViewport(SLOT, { width: 1500, height: 720 });
    expect(fitted.scale).toBeCloseTo(1280 / 1500);
    expect(fitted.width).toBeCloseTo(1500);
  });

  it('never shrinks below the floor and flags the overflow it leaves', () => {
    const fitted = fitGenUiViewport(SLOT, { width: 1280, height: 2000 });
    expect(GENUI_FIT_MIN_SCALE_RATIO).toBe(0.75);
    expect(fitted.scale).toBeCloseTo(0.75);
    expect(fitted.height).toBeCloseTo(960);
    expect(fitted.atFloor).toBe(true);
  });

  it('never grows the scale past the slot fit for small content', () => {
    expect(fitGenUiViewport(SLOT, { width: 300, height: 200 }).scale).toBe(1);
  });

  it('grows the viewport to a reported overflow, then stops when it fits', () => {
    const first = fitGenUiViewport(SLOT);
    const grown = reduceGenUiFit(
      INITIAL_GENUI_FIT_STATE,
      reportAt(first, { width: 1280, height: 900 }),
      first,
    );
    expect(grown.content).toEqual({ width: 1280, height: 900 });
    expect(grown.refits).toBe(1);
    const second = fitGenUiViewport(SLOT, grown.content);
    // The page reflowed at its wider viewport and now fits.
    const settled = reduceGenUiFit(grown, reportAt(second, { width: 1600, height: 880 }), second);
    expect(settled).toEqual({ ...grown, lastOverflow: null });
    expect(fitGenUiViewport(SLOT, settled.content)).toEqual(second);
  });

  it('refits again when the learner reveals more content after a fit', () => {
    const first = fitGenUiViewport(SLOT);
    const grown = reduceGenUiFit(
      INITIAL_GENUI_FIT_STATE,
      reportAt(first, { width: 1280, height: 800 }),
      first,
    );
    const second = fitGenUiViewport(SLOT, grown.content);
    const fits = reduceGenUiFit(
      grown,
      reportAt(second, { width: second.width, height: 800 }),
      second,
    );
    // A section opens: far more overflow than before, but not a failed refit.
    const opened = reduceGenUiFit(
      fits,
      reportAt(second, { width: second.width, height: 900 }),
      second,
    );
    expect(opened.settled).toBe(false);
    expect(opened.content).toEqual({ width: second.width, height: 900 });
    expect(fitGenUiViewport(SLOT, opened.content).scale).toBeCloseTo(0.8);
  });

  it('ignores reports measured at a viewport the frame has since replaced', () => {
    const applied = fitGenUiViewport(SLOT, { width: 1280, height: 900 });
    const stale = reportAt({ width: 1280, height: 720 }, { width: 1280, height: 1200 });
    const state: GenUiFitState = {
      ...INITIAL_GENUI_FIT_STATE,
      content: { width: 1280, height: 900 },
    };
    expect(reduceGenUiFit(state, stale, applied)).toBe(state);
  });

  it('reverts and settles when the layout grows with its viewport', () => {
    // height: calc(100vh + 200px): every refit leaves the same 200px overflow.
    let state = INITIAL_GENUI_FIT_STATE;
    let applied = fitGenUiViewport(SLOT);
    for (let i = 0; i < 10 && !state.settled; i += 1) {
      state = reduceGenUiFit(
        state,
        reportAt(applied, { width: applied.width, height: applied.height + 200 }),
        applied,
      );
      applied = fitGenUiViewport(SLOT, state.content);
    }
    expect(state.settled).toBe(true);
    expect(state.content).toBeNull();
    expect(state.refits).toBe(1);
    expect(applied.scale).toBe(1);
  });

  it('bounds the refits per load even when each one helps a little', () => {
    let state = INITIAL_GENUI_FIT_STATE;
    let applied = fitGenUiViewport(SLOT);
    let reports = 0;
    for (; reports < 50 && !state.settled; reports += 1) {
      // Content that shrinks its overflow by a sliver each time.
      const overflow = 60 - state.refits * 10;
      state = reduceGenUiFit(
        state,
        reportAt(applied, { width: applied.width, height: applied.height + overflow }),
        applied,
      );
      applied = fitGenUiViewport(SLOT, state.content);
    }
    expect(state.settled).toBe(true);
    expect(state.refits).toBe(GENUI_FIT_MAX_REFITS);
    expect(applied.scale).toBeGreaterThanOrEqual(GENUI_FIT_MIN_SCALE_RATIO);
  });

  it('settles at the floor and keeps the floor scale', () => {
    const first = fitGenUiViewport(SLOT);
    const grown = reduceGenUiFit(
      INITIAL_GENUI_FIT_STATE,
      reportAt(first, { width: 1280, height: 1400 }),
      first,
    );
    const atFloor = fitGenUiViewport(SLOT, grown.content);
    expect(atFloor.atFloor).toBe(true);
    const settled = reduceGenUiFit(
      grown,
      reportAt(atFloor, { width: atFloor.width, height: 1300 }, 340),
      atFloor,
    );
    expect(settled.settled).toBe(true);
    expect(fitGenUiViewport(SLOT, settled.content).scale).toBeCloseTo(0.75);
  });

  it('shows the more-below cue only past the floor and until scrolled to the end', () => {
    const atFloor = fitGenUiViewport(SLOT, { width: 1280, height: 2000 });
    const state = { ...INITIAL_GENUI_FIT_STATE, content: { width: 1280, height: 2000 } };
    expect(
      shouldShowGenUiMoreCue(reportAt(atFloor, { width: 1280, height: 2000 }, 500), atFloor, state),
    ).toBe(true);
    expect(
      shouldShowGenUiMoreCue(reportAt(atFloor, { width: 1280, height: 2000 }, 0), atFloor, state),
    ).toBe(false);
    // Mid-fit (not at the floor, not settled): no cue while the frame is still adjusting.
    const fitting = fitGenUiViewport(SLOT);
    expect(
      shouldShowGenUiMoreCue(
        reportAt(fitting, { width: 1280, height: 800 }, 80),
        fitting,
        INITIAL_GENUI_FIT_STATE,
      ),
    ).toBe(false);
    expect(
      shouldShowGenUiMoreCue(reportAt(fitting, { width: 1280, height: 800 }, 80), fitting, {
        ...INITIAL_GENUI_FIT_STATE,
        settled: true,
      }),
    ).toBe(true);
    expect(shouldShowGenUiMoreCue(null, atFloor, state)).toBe(false);
  });

  it('accepts only well-formed content-extent messages', () => {
    const good = {
      __maicInteractive: true,
      kind: 'content-extent',
      viewportWidth: 1280,
      viewportHeight: 720,
      contentWidth: 1300,
      contentHeight: 900,
      scrollRemaining: 180,
    };
    expect(parseGenUiContentReport(good)).toEqual({
      viewportWidth: 1280,
      viewportHeight: 720,
      contentWidth: 1300,
      contentHeight: 900,
      scrollRemaining: 180,
    });
    expect(parseGenUiContentReport({ ...good, kind: 'runtime-error' })).toBeNull();
    expect(parseGenUiContentReport({ ...good, __maicInteractive: false })).toBeNull();
    expect(parseGenUiContentReport({ ...good, contentHeight: 'tall' })).toBeNull();
    expect(parseGenUiContentReport({ ...good, contentHeight: Number.NaN })).toBeNull();
    expect(parseGenUiContentReport({ ...good, contentHeight: -1 })).toBeNull();
    expect(parseGenUiContentReport(null)).toBeNull();
  });
});
