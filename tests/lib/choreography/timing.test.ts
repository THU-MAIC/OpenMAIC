import { describe, expect, it } from 'vitest';
import {
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  DISCUSSION_AUTO_SKIP_MS,
  MAX_VIDEO_WAIT_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  WB_DELETE_MS,
  WB_CLOSE_MS,
  WIDGET_MS,
  wbDrawCodeMs,
  wbClearMs,
  estimateSpeechDurationMs,
} from '@/lib/choreography';

describe('timing constants pin the values moved from the app engines', () => {
  it('effect / scene timing', () => {
    expect(EFFECT_AUTO_CLEAR_MS).toBe(5000);
    expect(DISCUSSION_TRIGGER_DELAY_MS).toBe(3000);
    expect(DISCUSSION_AUTO_SKIP_MS).toBe(5000);
    expect(MAX_VIDEO_WAIT_MS).toBe(5 * 60 * 1000);
  });

  it('whiteboard / widget action durations', () => {
    expect(WB_OPEN_MS).toBe(2000);
    expect(WB_DRAW_MS).toBe(800);
    expect(WB_EDIT_MS).toBe(600);
    expect(WB_DELETE_MS).toBe(300);
    expect(WB_CLOSE_MS).toBe(700);
    expect(WIDGET_MS).toBe(300);
  });
});

describe('wbDrawCodeMs — base 800ms + 50ms/line, capped at 3000ms', () => {
  it('matches Math.min(800 + lines * 50, 3000)', () => {
    expect(wbDrawCodeMs(0)).toBe(800);
    expect(wbDrawCodeMs(1)).toBe(850);
    expect(wbDrawCodeMs(10)).toBe(1300);
    // cap kicks in at 44 lines (800 + 2200 = 3000)
    expect(wbDrawCodeMs(44)).toBe(3000);
    expect(wbDrawCodeMs(1000)).toBe(3000);
  });
});

describe('wbClearMs — base 380ms + 55ms/element, capped at 1400ms', () => {
  it('matches Math.min(380 + count * 55, 1400)', () => {
    expect(wbClearMs(0)).toBe(380);
    expect(wbClearMs(1)).toBe(435);
    expect(wbClearMs(10)).toBe(930);
    // cap kicks in at ~18.5 elements → 19 elements exceeds 1400
    expect(wbClearMs(19)).toBe(1400);
    expect(wbClearMs(500)).toBe(1400);
  });
});

describe('estimateSpeechDurationMs — deterministic no-audio dwell', () => {
  it('CJK text: ~150ms/char, floored at 2000ms', () => {
    // 20 CJK chars → 20 * 150 = 3000ms
    expect(estimateSpeechDurationMs('中'.repeat(20))).toBe(3000);
    // short CJK below the floor
    expect(estimateSpeechDurationMs('中文')).toBe(2000);
  });

  it('non-CJK text: ~240ms/word (≈250 WPM), floored at 2000ms', () => {
    // 20 words → 20 * 240 = 4800ms
    const twentyWords = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(estimateSpeechDurationMs(twentyWords)).toBe(4800);
    // few words below the floor
    expect(estimateSpeechDurationMs('hello world')).toBe(2000);
  });

  it('CJK threshold is >30% CJK characters', () => {
    // Mostly ASCII with a couple CJK chars → treated as non-CJK (word-based).
    const text = 'this is a long english sentence with 中文 words in it';
    const words = text.split(/\s+/).filter(Boolean).length;
    expect(estimateSpeechDurationMs(text)).toBe(Math.max(2000, words * 240));
  });

  it('divides by playback speed', () => {
    const base = estimateSpeechDurationMs('中'.repeat(20));
    expect(estimateSpeechDurationMs('中'.repeat(20), { speed: 2 })).toBe(base / 2);
    expect(estimateSpeechDurationMs('中'.repeat(20), { speed: 0.5 })).toBe(base / 0.5);
  });

  it('empty text falls to the 2000ms floor', () => {
    expect(estimateSpeechDurationMs('')).toBe(2000);
  });
});
