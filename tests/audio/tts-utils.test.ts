import { describe, expect, it } from 'vitest';
import { speechForTts } from '@openmaic/dsl';

import {
  splitLongSpeechText,
  splitLongSpeechActions,
  TTS_MAX_TEXT_LENGTH,
} from '@/lib/audio/tts-utils';
import type { Action, SpeechAction } from '@/lib/types/action';

describe('splitLongSpeechText', () => {
  it('returns the trimmed text unchanged when within the limit', () => {
    expect(splitLongSpeechText('  hello world  ', 100)).toEqual(['hello world']);
  });

  it('splits at sentence boundaries, keeping the punctuation', () => {
    expect(splitLongSpeechText('句子一。句子二！句子三？', 6)).toEqual([
      '句子一。',
      '句子二！',
      '句子三？',
    ]);
  });

  it('packs consecutive short sentences up to the limit', () => {
    const out = splitLongSpeechText('aa。bb。cc。dd。', 6);
    expect(out).toEqual(['aa。bb。', 'cc。dd。']);
    expect(out.join('')).toBe('aa。bb。cc。dd。');
  });

  it('falls back to clause punctuation for an over-long sentence', () => {
    const out = splitLongSpeechText('一，二，三，四，五', 4);
    expect(out.every((c) => c.length <= 4)).toBe(true);
    expect(out.join('').replace(/，/g, '')).toContain('一');
  });

  it('hard-splits a long run with no punctuation', () => {
    expect(splitLongSpeechText('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('never emits a chunk longer than maxLength, nor an empty chunk (invariant)', () => {
    const text = '这是一个很长的句子，包含很多子句、标点。'.repeat(50) + 'z'.repeat(120);
    for (const max of [8, 16, 64, 200]) {
      const out = splitLongSpeechText(text, max);
      expect(
        out.every((c) => c.length <= max),
        `max=${max}`,
      ).toBe(true);
      expect(
        out.some((c) => c.length === 0),
        `max=${max}`,
      ).toBe(false);
    }
  });
});

describe('splitLongSpeechActions', () => {
  const speech = (id: string, text: string): SpeechAction =>
    ({ id, type: 'speech', text }) as SpeechAction;

  it('returns actions untouched for a provider with no length limit', () => {
    const actions: Action[] = [speech('a', 'x'.repeat(5000))];
    expect(splitLongSpeechActions(actions, 'openai-tts')).toBe(actions);
  });

  it('leaves short speech and non-speech actions unchanged', () => {
    const actions: Action[] = [speech('s', 'short'), { id: 'sp', type: 'spotlight' } as Action];
    expect(splitLongSpeechActions(actions, 'glm-tts')).toBe(actions);
  });

  it('splits an over-limit speech action into chunked sub-actions', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!; // 1024
    const long = '句子。'.repeat(400); // 1200 chars > 1024
    const out = splitLongSpeechActions([speech('a', long)], 'glm-tts') as SpeechAction[];

    expect(out.length).toBeGreaterThan(1);
    expect(out.every((a) => a.type === 'speech' && a.text.length <= max)).toBe(true);
    // deterministic sub-action ids…
    expect(out.map((a) => a.id)).toEqual(out.map((_, i) => `a_tts_${i + 1}`));
    // …each gets its own audio (the parent audioId is dropped)…
    expect(out.every((a) => a.audioId === undefined)).toBe(true);
    // …and the text is preserved across the split.
    expect(out.map((a) => a.text).join('')).toBe(long);
  });

  it('splits paired spokenText alongside caption chunks without repeating or exceeding the limit', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const displaySentence = '导数定义为 $f(x)$。';
    const spokenSentence = '导数定义为函数 f 括号 x 括号的极限变化率。';
    const original: SpeechAction = {
      id: 'paired',
      type: 'speech',
      text: displaySentence.repeat(120),
      spokenText: spokenSentence.repeat(120),
      audioId: 'ast_old',
    };
    const out = splitLongSpeechActions([original], 'glm-tts') as SpeechAction[];
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((a) => a.audioId === undefined)).toBe(true);
    expect(out.every((a) => a.text.length <= max && speechForTts(a).length <= max)).toBe(true);
    expect(out.map((a) => a.text).join('')).toBe(original.text);
    expect(out.map((a) => speechForTts(a)).join('')).toBe(original.spokenText);

    // Also splits when the caption is short but the spoken reading exceeds the provider cap.
    const shortCaptionLongReading: SpeechAction = {
      id: 'reading-heavy',
      type: 'speech',
      text: '$S_n = \\sum_{k=1}^{n} a_k$',
      spokenText: '第 k 项从一累加到第 n 项的求和结果。'.repeat(90),
    };
    const readingOut = splitLongSpeechActions(
      [shortCaptionLongReading],
      'glm-tts',
    ) as SpeechAction[];
    expect(readingOut.length).toBeGreaterThan(1);
    expect(readingOut.every((a) => speechForTts(a).length <= max)).toBe(true);
    expect(readingOut.map((a) => speechForTts(a)).join('')).toBe(
      shortCaptionLongReading.spokenText,
    );
  });
});
