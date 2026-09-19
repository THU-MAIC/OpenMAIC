import { describe, expect, it } from 'vitest';
import {
  resolveActionTimeline,
  IMPLICIT_WB_OPEN,
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  DISCUSSION_AUTO_SKIP_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  wbDrawCodeMs,
  wbClearMs,
  estimateSpeechDurationMs,
} from '@/lib/choreography';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const act = (a: Partial<Action> & { type: string }): Action => a as unknown as Action;
const speech = (id: string, text: string): Action => act({ id, type: 'speech', text });
const sc = (id: string, actions: Action[]): Scene =>
  ({
    id,
    stageId: 's',
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  }) as unknown as Scene;

describe('resolveActionTimeline — blocking actions advance the cursor', () => {
  it('speech falls back to the deterministic estimate and accumulates startMs', () => {
    const scenes = [sc('S0', [speech('a', '中'.repeat(20)), speech('b', 'hello world')])];
    const tl = resolveActionTimeline(scenes);

    const d0 = estimateSpeechDurationMs('中'.repeat(20)); // 3000
    const d1 = estimateSpeechDurationMs('hello world'); // 2000 floor

    expect(tl).toHaveLength(2);
    expect(tl[0]).toMatchObject({
      sceneId: 'S0',
      sceneIndex: 0,
      actionIndex: 0,
      startMs: 0,
      durationMs: d0,
      advancesCursorMs: d0,
      blocking: true,
    });
    expect(tl[1]).toMatchObject({ startMs: d0, durationMs: d1, advancesCursorMs: d1 });
  });

  it('a supplied audio-duration resolver overrides the estimate', () => {
    const scenes = [sc('S0', [speech('a', 'anything')])];
    const tl = resolveActionTimeline(scenes, { getAudioDurationMs: () => 7777 });
    expect(tl[0]).toMatchObject({ durationMs: 7777, advancesCursorMs: 7777 });
  });

  it('playback speed scales both the estimate and supplied audio', () => {
    const scenes = [sc('S0', [speech('a', '中'.repeat(20))])];
    const tl = resolveActionTimeline(scenes, { playbackSpeed: 2 });
    expect(tl[0].durationMs).toBe(estimateSpeechDurationMs('中'.repeat(20)) / 2);

    // Real audio is scaled the same way (the live path sets AudioPlayer playbackRate).
    const withAudio = resolveActionTimeline(scenes, {
      playbackSpeed: 2,
      getAudioDurationMs: () => 10_000,
    });
    expect(withAudio[0]).toMatchObject({ durationMs: 5000, advancesCursorMs: 5000 });
  });
});

describe('resolveActionTimeline — fire-and-forget effects do not advance the cursor', () => {
  it('effects start at the cursor but advance it by 0 (blocking:false)', () => {
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        act({ id: 'la', type: 'laser', elementId: 'e2' }),
        speech('s', 'hi there'),
      ]),
    ];
    const tl = resolveActionTimeline(scenes);

    // Both effects and the speech start at 0 — the effects didn't move the clock.
    expect(tl[0]).toMatchObject({ startMs: 0, advancesCursorMs: 0, blocking: false });
    expect(tl[1]).toMatchObject({ startMs: 0, advancesCursorMs: 0, blocking: false });
    expect(tl[2]).toMatchObject({ startMs: 0, blocking: true });
  });

  it('an effect is cleared at playback completion, not a flat 5s later', () => {
    // spotlight fires at 0; the only speech ends at 2000, then processNext hits
    // completion → clearEffects. So the effect lives 2000ms, not EFFECT_AUTO_CLEAR_MS.
    const scenes = [
      sc('S0', [act({ id: 'sp', type: 'spotlight', elementId: 'e1' }), speech('s', 'hi there')]),
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl[0]).toMatchObject({ startMs: 0, durationMs: 2000, blocking: false });
  });

  it('an effect is cleared at the next scene boundary', () => {
    const scenes = [
      sc('S0', [act({ id: 'sp', type: 'spotlight', elementId: 'e1' }), speech('a', 'hi there')]), // 0..2000
      sc('S1', [speech('b', 'more')]),
    ];
    // clearEffects fires at the start of S1 (2000), cutting the spotlight there.
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(2000);
  });

  it('lives its full EFFECT_AUTO_CLEAR_MS when the scene runs long enough', () => {
    // speech dwell 6000 > 5000, so the auto-clear timer fires before the boundary.
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        speech('s', '中'.repeat(40)),
      ]),
    ];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(EFFECT_AUTO_CLEAR_MS);
  });

  it('a later effect resets the shared clear timer, extending earlier effects', () => {
    // spotlight@0, then speech(3000), then laser@3000 (resets the shared timer),
    // then speech(6000) → completion 9000. The shared timer last fires at
    // 3000+5000=8000, so BOTH effects clear together at 8000: spotlight lives
    // 8000ms (extended past its own 5000), laser lives 5000ms.
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        speech('a', '中'.repeat(20)), // 3000
        act({ id: 'la', type: 'laser', elementId: 'e2' }),
        speech('b', '中'.repeat(40)), // 6000
      ]),
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl[0]).toMatchObject({ startMs: 0, durationMs: 8000, blocking: false }); // spotlight
    expect(tl[2]).toMatchObject({
      startMs: 3000,
      durationMs: EFFECT_AUTO_CLEAR_MS,
      blocking: false,
    }); // laser
  });

  it('breaks the chain when the gap between effects exceeds EFFECT_AUTO_CLEAR_MS', () => {
    // spotlight@0; speech(6000) > 5000, so the shared timer for the spotlight
    // already fired at 5000 before the laser@6000 arrives. The laser starts a
    // fresh 5000 window. Long trailing speech keeps both within their own scene.
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        speech('a', '中'.repeat(40)), // 6000
        act({ id: 'la', type: 'laser', elementId: 'e2' }),
        speech('b', '中'.repeat(40)), // 6000 → completion 12000
      ]),
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl[0]).toMatchObject({ startMs: 0, durationMs: EFFECT_AUTO_CLEAR_MS }); // spotlight: own 5000
    expect(tl[2]).toMatchObject({ startMs: 6000, durationMs: EFFECT_AUTO_CLEAR_MS }); // laser: own 5000
  });

  it('breaks the chain at an EXACT 5s boundary (earlier clear timer fires first)', () => {
    // spotlight@0; speech of exactly 5000ms; laser@5000. The spotlight's clear
    // timer was queued first (same 5000ms delay), so it fires before the laser
    // resets it — the spotlight lives exactly 5000, not 10000.
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        speech('a', 'anything'), // 5000 via audio resolver
        act({ id: 'la', type: 'laser', elementId: 'e2' }),
        speech('b', 'anything'), // 5000 → completion 10000
      ]),
    ];
    const tl = resolveActionTimeline(scenes, { getAudioDurationMs: () => 5000 });
    expect(tl[0]).toMatchObject({ startMs: 0, durationMs: EFFECT_AUTO_CLEAR_MS }); // spotlight: exactly 5000
    expect(tl[2]).toMatchObject({ startMs: 5000, durationMs: EFFECT_AUTO_CLEAR_MS }); // laser: own 5000
  });

  it('a later scene never extends an earlier scene effect (boundary clears first)', () => {
    const scenes = [
      sc('S0', [act({ id: 'sp', type: 'spotlight', elementId: 'e1' }), speech('a', 'hi there')]), // 0..2000
      sc('S1', [act({ id: 'la', type: 'laser', elementId: 'e2' }), speech('b', 'more')]),
    ];
    // S0's spotlight is cut at S1's start (2000), NOT extended by S1's laser@2000.
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(2000);
  });

  it('an effect as the last action of a scene has 0ms visual duration', () => {
    // The engine fires the effect, queueMicrotask(processNext) hits completion,
    // and clearEffects runs before real time elapses → 0ms.
    const scenes = [
      sc('S0', [speech('a', 'hi there'), act({ id: 'sp', type: 'spotlight', elementId: 'e1' })]),
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl[1]).toMatchObject({ startMs: 2000, durationMs: 0, blocking: false });
  });
});

describe('resolveActionTimeline — per-action durations', () => {
  it('wb_draw_code uses the line-count formula', () => {
    const code = 'a\nb\nc\nd'; // 4 lines
    const scenes = [sc('S0', [act({ id: 'c', type: 'wb_draw_code', code })])];
    const tl = resolveActionTimeline(scenes, { whiteboardOpen: true });
    expect(tl[0].durationMs).toBe(wbDrawCodeMs(4));
  });

  it('wb_clear is 0ms when empty and scales with the supplied live element count', () => {
    const scenes = [
      sc('S0', [act({ id: 'o', type: 'wb_open' }), act({ id: 'cl', type: 'wb_clear' })]),
    ];
    // Empty board → engine early-returns with no delay, so 0ms (not wbClearMs(0)).
    expect(resolveActionTimeline(scenes)[1].durationMs).toBe(0);
    expect(resolveActionTimeline(scenes, { getClearElementCount: () => 10 })[1].durationMs).toBe(
      wbClearMs(10),
    );
  });

  it('wb_draw_* share WB_DRAW_MS', () => {
    const scenes = [sc('S0', [act({ id: 't', type: 'wb_draw_text', content: 'hi' })])];
    expect(resolveActionTimeline(scenes, { whiteboardOpen: true })[0].durationMs).toBe(WB_DRAW_MS);
  });

  it('no-op whiteboard draws cost 0ms (engine early-returns)', () => {
    // wb_draw_text with empty content → executeWbDrawText returns before delay.
    const emptyText = [sc('S0', [act({ id: 't', type: 'wb_draw_text', content: '' })])];
    expect(resolveActionTimeline(emptyText, { whiteboardOpen: true })[0].durationMs).toBe(0);
    // wb_draw_table with no rows → executeWbDrawTable returns early.
    const emptyTable = [sc('S0', [act({ id: 'tb', type: 'wb_draw_table', data: [] })])];
    expect(resolveActionTimeline(emptyTable, { whiteboardOpen: true })[0].durationMs).toBe(0);
    // A populated table still costs WB_DRAW_MS.
    const table = [sc('S0', [act({ id: 'tb2', type: 'wb_draw_table', data: [['a', 'b']] })])];
    expect(resolveActionTimeline(table, { whiteboardOpen: true })[0].durationMs).toBe(WB_DRAW_MS);
  });

  it('discussion dwells for trigger delay + card auto-skip (unattended playback)', () => {
    const scenes = [sc('S0', [act({ id: 'd', type: 'discussion', topic: 't' })])];
    // Not skipped: the 3s trigger delay, then the ProactiveCard's 5s auto-skip
    // countdown before playback continues.
    expect(resolveActionTimeline(scenes)[0]).toMatchObject({
      durationMs: DISCUSSION_TRIGGER_DELAY_MS + DISCUSSION_AUTO_SKIP_MS,
      blocking: true,
    });
  });

  it('a skipped discussion (consumed / agent not selected) contributes no dwell', () => {
    const scenes = [sc('S0', [act({ id: 'd', type: 'discussion', topic: 't' })])];
    // Engine skips it (processNext recurses with no timer) → 0ms.
    expect(resolveActionTimeline(scenes, { isDiscussionSkipped: () => true })[0].durationMs).toBe(
      0,
    );
    // Not skipped → trigger delay + card auto-skip, same as the default.
    expect(resolveActionTimeline(scenes, { isDiscussionSkipped: () => false })[0].durationMs).toBe(
      DISCUSSION_TRIGGER_DELAY_MS + DISCUSSION_AUTO_SKIP_MS,
    );
  });

  it('wb_edit_code is WB_EDIT_MS by default and 0ms when the caller flags a no-op', () => {
    const scenes = [
      sc('S0', [
        act({ id: 'e', type: 'wb_edit_code', elementId: 'c1', operation: 'delete_lines' }),
      ]),
    ];
    expect(resolveActionTimeline(scenes, { whiteboardOpen: true })[0].durationMs).toBe(WB_EDIT_MS);
    // Stale target / non-code element → executeWbEditCode returns before its delay.
    expect(
      resolveActionTimeline(scenes, { whiteboardOpen: true, isEditCodeNoop: () => true })[0]
        .durationMs,
    ).toBe(0);
  });

  it('play_video uses the supplied duration (capped); unresolved is explicit, not silent 0', () => {
    const scenes = [sc('S0', [act({ id: 'v', type: 'play_video', elementId: 'v1' })])];
    // Supplied duration is used, capped at MAX_VIDEO_WAIT_MS (5min).
    expect(resolveActionTimeline(scenes, { getVideoDurationMs: () => 12_345 })[0].durationMs).toBe(
      12_345,
    );
    expect(
      resolveActionTimeline(scenes, { getVideoDurationMs: () => 60 * 60 * 1000 })[0].durationMs,
    ).toBe(5 * 60 * 1000);
    // Unresolved: default policy THROWS rather than silently shifting later actions early.
    expect(() => resolveActionTimeline(scenes)).toThrow(/play_video/);
    // Opt-in policies: 'cap' → max wait, 'zero' → explicit no-dwell.
    expect(resolveActionTimeline(scenes, { onUnresolvedVideoDuration: 'cap' })[0].durationMs).toBe(
      5 * 60 * 1000,
    );
    expect(resolveActionTimeline(scenes, { onUnresolvedVideoDuration: 'zero' })[0].durationMs).toBe(
      0,
    );
  });
});

describe('resolveActionTimeline — scene boundaries', () => {
  it('an empty scene yields one EMPTY_SCENE_DWELL beat', () => {
    const scenes = [sc('S0', [])];
    const tl = resolveActionTimeline(scenes);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({
      sceneId: 'S0',
      actionIndex: 0,
      // empty-text speech → 2000ms floor
      durationMs: estimateSpeechDurationMs(''),
      blocking: true,
    });
    expect(tl[0].action).toMatchObject({ type: 'speech', text: '' });
  });

  it('startMs accumulates across scenes in play order', () => {
    const scenes = [
      sc('S0', [speech('a', 'hello world')]), // 2000
      sc('S1', []), // empty dwell 2000
      sc('S2', [speech('c', '中'.repeat(20))]), // 3000
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl.map((s) => [s.sceneId, s.startMs])).toEqual([
      ['S0', 0],
      ['S1', 2000],
      ['S2', 4000],
    ]);
  });
});

describe('resolveActionTimeline — implicit whiteboard auto-open', () => {
  it('prepends a WB_OPEN_MS beat before the first wb_* mutation on a closed board', () => {
    const scenes = [sc('S0', [act({ id: 'd', type: 'wb_draw_text', content: 'hi' })])];
    const tl = resolveActionTimeline(scenes); // whiteboardOpen defaults to false

    expect(tl).toHaveLength(2);
    expect(tl[0]).toMatchObject({
      action: IMPLICIT_WB_OPEN,
      startMs: 0,
      durationMs: WB_OPEN_MS,
      advancesCursorMs: WB_OPEN_MS,
      blocking: true,
    });
    // The real draw starts after the open animation.
    expect(tl[1]).toMatchObject({ startMs: WB_OPEN_MS, durationMs: WB_DRAW_MS });
  });

  it('does not prepend when the board is already open (seeded or via wb_open)', () => {
    const drawOnly = [sc('S0', [act({ id: 'd', type: 'wb_draw_text' })])];
    expect(resolveActionTimeline(drawOnly, { whiteboardOpen: true })).toHaveLength(1);

    const explicitOpen = [
      sc('S0', [act({ id: 'o', type: 'wb_open' }), act({ id: 'd', type: 'wb_draw_text' })]),
    ];
    const tl = resolveActionTimeline(explicitOpen);
    // Only the authored wb_open + the draw — no synthetic beat.
    expect(tl.map((s) => s.action.type)).toEqual(['wb_open', 'wb_draw_text']);
    expect(tl[0].action).not.toBe(IMPLICIT_WB_OPEN);
  });

  it('re-opens after a wb_close (auto-open state carries across the sequence)', () => {
    const scenes = [
      sc('S0', [
        act({ id: 'd1', type: 'wb_draw_text' }), // implicit open here
        act({ id: 'x', type: 'wb_close' }),
        act({ id: 'd2', type: 'wb_draw_shape' }), // implicit open again
      ]),
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl.map((s) => s.action.type)).toEqual([
      'wb_open', // implicit (before d1)
      'wb_draw_text',
      'wb_close',
      'wb_open', // implicit (before d2, board was closed again)
      'wb_draw_shape',
    ]);
    expect(tl.filter((s) => s.action === IMPLICIT_WB_OPEN)).toHaveLength(2);
  });

  it('carries open state across scene boundaries', () => {
    const scenes = [
      sc('S0', [act({ id: 'd1', type: 'wb_draw_text' })]), // implicit open
      sc('S1', [act({ id: 'd2', type: 'wb_draw_shape' })]), // still open — no new open
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl.map((s) => s.action.type)).toEqual(['wb_open', 'wb_draw_text', 'wb_draw_shape']);
  });

  it('wb_clear/wb_delete on a closed board also trigger the implicit open', () => {
    const scenes = [sc('S0', [act({ id: 'cl', type: 'wb_clear' })])];
    const tl = resolveActionTimeline(scenes);
    expect(tl[0].action).toBe(IMPLICIT_WB_OPEN);
    // wb_clear on an (implicitly) empty board is still 0ms.
    expect(tl[1]).toMatchObject({ startMs: WB_OPEN_MS, durationMs: 0 });
  });
});
