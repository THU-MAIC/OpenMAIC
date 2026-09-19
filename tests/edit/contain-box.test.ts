import { describe, expect, test } from 'vitest';
import {
  CLASSROOM_ASPECT_RATIO,
  clampWorkbenchPanelWidth,
  containBox,
  fillWidthBox,
  idealWorkbenchPanelWidth,
  WORKBENCH_CHAT_MIN_PX,
  WORKBENCH_PANEL_MIN_PX,
} from '@/lib/edit/contain-box';

describe('containBox', () => {
  test('height-limits a wide host so a 16:9 canvas fills the height', () => {
    const box = containBox(1200, 500, CLASSROOM_ASPECT_RATIO);
    expect(box.height).toBe(500);
    expect(box.width).toBeCloseTo(500 * (16 / 9));
  });

  test('width-limits a tall host so a 16:9 canvas fills the width', () => {
    const box = containBox(800, 900, CLASSROOM_ASPECT_RATIO);
    expect(box.width).toBe(800);
    expect(box.height).toBeCloseTo(800 * (9 / 16));
  });

  test('returns the container itself when it is already 16:9', () => {
    expect(containBox(1600, 900, CLASSROOM_ASPECT_RATIO)).toEqual({
      width: 1600,
      height: 900,
    });
  });

  test('returns a zero box for non-positive or non-finite input', () => {
    expect(containBox(0, 500, CLASSROOM_ASPECT_RATIO)).toEqual({ width: 0, height: 0 });
    expect(containBox(800, -1, CLASSROOM_ASPECT_RATIO)).toEqual({ width: 0, height: 0 });
    expect(containBox(Number.NaN, 500, CLASSROOM_ASPECT_RATIO)).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe('fillWidthBox', () => {
  test('uses the full host width and derives 16:9 height', () => {
    expect(fillWidthBox(1600, CLASSROOM_ASPECT_RATIO)).toEqual({ width: 1600, height: 900 });
  });
});

describe('clampWorkbenchPanelWidth', () => {
  test('keeps the conversation at its minimum', () => {
    expect(clampWorkbenchPanelWidth(1200, 900)).toBe(800);
  });

  test('does not shrink the classroom below its minimum', () => {
    expect(clampWorkbenchPanelWidth(2000, 100)).toBe(WORKBENCH_PANEL_MIN_PX);
  });
});

describe('idealWorkbenchPanelWidth', () => {
  test('on an ultrawide, sizes the panel to the 16:9 stage and leaves the rest to chat', () => {
    const panel = idealWorkbenchPanelWidth(3440, 1080, { playback: true });
    expect(panel).toBeLessThan(3440 * 0.55);
    expect(3440 - panel).toBeGreaterThan(WORKBENCH_CHAT_MIN_PX);
    expect(panel).toBeGreaterThan(WORKBENCH_PANEL_MIN_PX);
  });

  test('never steals the conversation below its minimum', () => {
    const panel = idealWorkbenchPanelWidth(1200, 900);
    expect(panel).toBe(1200 - WORKBENCH_CHAT_MIN_PX);
  });

  test('playback chrome (roundtable) makes the panel narrower than edit', () => {
    const edit = idealWorkbenchPanelWidth(3440, 1440, { playback: false });
    const playback = idealWorkbenchPanelWidth(3440, 1440, { playback: true });
    expect(playback).toBeLessThan(edit);
  });
});
