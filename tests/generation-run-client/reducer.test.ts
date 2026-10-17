import { describe, expect, it } from 'vitest';

import {
  applyRunEvent,
  followFrom,
  viewFromSnapshot,
  visibleOutlines,
} from '@/lib/generation-run-client/reducer';

import { event, outline, snapshot } from './fixtures';

describe('run view reducer', () => {
  it('streams outline items, restarts on a reset and settles on the ready outline', () => {
    let view = viewFromSnapshot(snapshot({ state: 'outlining', seq: 2 }));
    view = applyRunEvent(view, event(3, 'outline_item', { index: 0, outline: outline(1) }));
    view = applyRunEvent(view, event(4, 'outline_item', { index: 1, outline: outline(2) }));
    expect(visibleOutlines(view).map((o) => o.id)).toEqual(['o1', 'o2']);

    view = applyRunEvent(view, event(5, 'outline_reset'));
    expect(view.streamingOutlines).toEqual([]);
    expect(view.outlineRetrying).toBe(true);

    view = applyRunEvent(
      view,
      event(6, 'outline_item', { index: 0, outline: outline(1, 'Again') }),
    );
    expect(view.outlineRetrying).toBe(false);
    const ready = {
      outlines: [outline(1), outline(2), outline(3)],
      languageDirective: 'en',
      taskEngineMode: false,
    };
    view = applyRunEvent(view, event(7, 'outline_ready', { revision: 1, outline: ready }));
    view = applyRunEvent(
      view,
      event(8, 'state', { state: 'awaiting_outline_confirmation', step: null }),
    );
    expect(view.state).toBe('awaiting_outline_confirmation');
    expect(view.outline?.revision).toBe(1);
    expect(visibleOutlines(view)).toHaveLength(3);
    expect(view.progress.scenesTotal).toBe(3);
  });

  it('ignores replayed frames at or below its seq', () => {
    let view = viewFromSnapshot(snapshot({ state: 'outlining', seq: 5 }));
    const replayed = applyRunEvent(
      view,
      event(5, 'outline_item', { index: 0, outline: outline(1) }),
    );
    expect(replayed).toBe(view);
    view = applyRunEvent(view, event(6, 'outline_item', { index: 0, outline: outline(1) }));
    view = applyRunEvent(view, event(6, 'outline_item', { index: 1, outline: outline(2) }));
    expect(view.streamingOutlines).toHaveLength(1);
  });

  it('follows a run before its outline from the first event, and any other from its seq', () => {
    const early = followFrom(snapshot({ state: 'outlining', seq: 9 }));
    expect(early.after).toBe(0);
    expect(early.view.seq).toBe(0);
    const ready = {
      outlines: [outline(1)],
      languageDirective: 'en',
      taskEngineMode: false,
      revision: 1,
    };
    const later = followFrom(snapshot({ state: 'generating', seq: 40, outline: ready }));
    expect(later.after).toBe(40);
    expect(later.view.seq).toBe(40);
    expect(visibleOutlines(later.view)).toHaveLength(1);
  });

  it('tracks the course, scene progress, pauses and the scenes the run went past', () => {
    const ready = {
      outlines: [outline(1), outline(2), outline(3)],
      languageDirective: 'en',
      taskEngineMode: false,
      revision: 1,
    };
    let view = viewFromSnapshot(
      snapshot({
        state: 'generating',
        seq: 10,
        outline: ready,
        progress: { scenesTotal: 3, scenesCompleted: 0 },
      }),
    );
    view = applyRunEvent(view, event(11, 'course_created', { stageId: 'stage-1' }));
    view = applyRunEvent(view, event(12, 'scene_ready', { index: 0, sceneId: 's1', order: 1 }));
    view = applyRunEvent(view, event(13, 'scene_ready', { index: 0, sceneId: 's1', order: 1 }));
    expect(view.stageId).toBe('stage-1');
    expect(view.progress.scenesCompleted).toBe(1);

    view = applyRunEvent(
      view,
      event(14, 'step_failed', { step: 'scene:1:content', message: 'boom', continuing: true }),
    );
    expect(view.skippedScenes).toEqual({ 1: 'boom' });
    expect(view.error).toBeNull();

    view = applyRunEvent(
      view,
      event(15, 'step_failed', { step: 'scene:1:content', message: 'boom' }),
    );
    view = applyRunEvent(view, event(16, 'state', { state: 'paused', step: 'scene:1:content' }));
    expect(view.state).toBe('paused');
    expect(view.error).toEqual({ step: 'scene:1:content', message: 'boom' });
    expect(view.failedSeq).toBe(15);

    view = applyRunEvent(
      view,
      event(17, 'state', { state: 'generating', step: 'scene:1:content' }),
    );
    expect(view.error).toBeNull();
    view = applyRunEvent(view, event(18, 'step_started', { step: 'scene:1:content' }));
    expect(view.stepStartedSeq).toBe(18);
    expect(view.skippedScenes).toEqual({});
  });

  it('records media states with the seq that set them', () => {
    let view = viewFromSnapshot(
      snapshot({
        state: 'generating',
        seq: 3,
        media: { gen_img_1: { mediaType: 'image', status: 'pending' } },
      }),
    );
    expect(view.media.gen_img_1).toEqual({ mediaType: 'image', status: 'pending', seq: 3 });
    view = applyRunEvent(
      view,
      event(4, 'media', {
        elementId: 'gen_img_1',
        mediaType: 'image',
        status: 'failed',
        message: 'nope',
        retryable: true,
      }),
    );
    view = applyRunEvent(
      view,
      event(5, 'media', { elementId: 'gen_vid_1', mediaType: 'video', status: 'disabled' }),
    );
    expect(view.media.gen_img_1).toMatchObject({ status: 'failed', retryable: true, seq: 4 });
    expect(view.media.gen_vid_1).toMatchObject({ status: 'disabled', seq: 5 });
  });

  it('keeps generated rosters for the agent cards and not preset agents', () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 1 }));
    view = applyRunEvent(
      view,
      event(2, 'agents', { agents: [{ id: 'a', name: 'A', role: 'teacher' }] }),
    );
    expect(view.generatedAgents).toBeNull();
    view = applyRunEvent(
      view,
      event(3, 'agents', { agents: [{ id: 'g', name: 'G', role: 'teacher', avatar: '/a.png' }] }),
    );
    expect(view.generatedAgents).toHaveLength(1);
  });
});

describe('persisted narration warnings', () => {
  it('restores the committed count on reload, including a completed run', () => {
    const view = viewFromSnapshot(snapshot({ state: 'completed', narrationUnvoiced: 3 }));
    expect(view.narrationUnvoiced).toBe(3);
  });

  it('uses the cumulative scene count without double-counting replayed events', () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 10, narrationUnvoiced: 2 }));
    const frame = event(11, 'scene_ready', {
      index: 1,
      sceneId: 's2',
      order: 2,
      narrationUnvoiced: 3,
    });
    view = applyRunEvent(view, frame);
    view = applyRunEvent(view, frame);
    expect(view.narrationUnvoiced).toBe(3);
    view = applyRunEvent(view, event(12, 'scene_ready', { index: 2, sceneId: 's3', order: 3 }));
    expect(view.narrationUnvoiced).toBe(3);
  });

  it('does not warn for snapshots without skipped narration', () => {
    expect(viewFromSnapshot(snapshot()).narrationUnvoiced).toBe(0);
  });
});
