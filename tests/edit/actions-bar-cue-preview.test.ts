import { describe, expect, test } from 'vitest';
import { cuePreviewFor } from '@/components/edit/ActionsBar/cue-preview';
import type { Action } from '@/lib/types/action';

const laser = { id: 'a1', type: 'laser', elementId: 'text_1' } as unknown as Action;
const spotlight = { id: 'a2', type: 'spotlight', elementId: 'text_2' } as unknown as Action;
const playVideo = { id: 'a3', type: 'play_video', elementId: 'video_1' } as unknown as Action;
const wbOpen = { id: 'a4', type: 'wb_open' } as unknown as Action;

describe('cuePreviewFor', () => {
  test('laser cue replays as a laser, NOT a spotlight', () => {
    // The bug: a laser cue was being previewed via setSpotlight, so it showed
    // as a spotlight instead of the laser pointer.
    expect(cuePreviewFor(laser)).toEqual({ kind: 'laser', elementId: 'text_1' });
  });

  test('spotlight cue previews as a spotlight', () => {
    expect(cuePreviewFor(spotlight)).toEqual({ kind: 'spotlight', elementId: 'text_2' });
  });

  test('element-bound non-laser cue (play_video) keeps the spotlight highlight', () => {
    expect(cuePreviewFor(playVideo)).toEqual({ kind: 'spotlight', elementId: 'video_1' });
  });

  test('a cue with no bound element has no canvas preview', () => {
    expect(cuePreviewFor(wbOpen)).toEqual({ kind: 'none' });
  });
});
