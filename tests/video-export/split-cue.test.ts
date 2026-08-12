import { describe, expect, it } from 'vitest';
import { splitCue, splitCues, splitCueText, textUnits } from '@/lib/video-export';
import type { SubtitleCue } from '@/lib/video-export';

/**
 * Cue splitting is the fix for burned-in subtitles that covered the slide: a
 * whole-paragraph cue is split into short line-sized cues whose spans tile the
 * parent's time window (by character weight), so both the burned-in overlay and
 * the sidecar SRT/VTT read line-by-line and stay in sync with the narration.
 */

const cue = (over: Partial<SubtitleCue> = {}): SubtitleCue => ({
  index: 0,
  sceneId: 's1',
  actionId: 'a1',
  startMs: 0,
  endMs: 10_000,
  text: '',
  ...over,
});

describe('splitCueText', () => {
  it('returns nothing for empty / whitespace text', () => {
    expect(splitCueText('')).toEqual([]);
    expect(splitCueText('   \n ')).toEqual([]);
  });

  it('keeps a short single sentence as one piece', () => {
    expect(splitCueText('这是一句短旁白。')).toEqual(['这是一句短旁白。']);
  });

  it('splits on sentence-ending punctuation when over budget', () => {
    // Two full-width sentences, each ~20 units → together over the 40 budget.
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const pieces = splitCueText(text);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece is within the readability budget.
    for (const p of pieces) expect(textUnits(p)).toBeLessThanOrEqual(40);
  });

  it('hard-wraps a long run with no punctuation', () => {
    const text = '啊'.repeat(120); // 120 wide units, no punctuation
    const pieces = splitCueText(text);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) expect(textUnits(p)).toBeLessThanOrEqual(40);
  });

  it('weights Latin characters at half a CJK cell', () => {
    expect(textUnits('中文')).toBe(2);
    expect(textUnits('abcd')).toBe(2);
  });

  it('keeps a decimal number inside one cue (does not split 3.14)', () => {
    expect(splitCueText('π is about 3.14 here.')).toEqual(['π is about 3.14 here.']);
  });

  it('keeps a dotted version inside one cue (does not split v1.2)', () => {
    expect(splitCueText('Upgrade to v1.2 today.')).toEqual(['Upgrade to v1.2 today.']);
  });

  it('does not split a lowercase abbreviation dot (e.g.)', () => {
    // `e.g.` must not fragment into `e.` / `g.` / trailing cues.
    expect(splitCueText('Some fruit, e.g. apples and pears.')).toEqual([
      'Some fruit, e.g. apples and pears.',
    ]);
  });

  it('does not split after a title before a name (Dr. Smith)', () => {
    // ICU alone ends the sentence at `Dr.`; the title post-merge re-joins the
    // capitalized continuation.
    expect(splitCueText('Ask Dr. Smith about it.')).toEqual(['Ask Dr. Smith about it.']);
    expect(splitCueText('Then Prof. Wang spoke up.')).toEqual(['Then Prof. Wang spoke up.']);
  });

  it('keeps a title before a number as one cue (Fig. 3, No. 5)', () => {
    // ICU never splits a title before a digit, so no merge is involved.
    expect(splitCueText('See Fig. 3 for the details.')).toEqual(['See Fig. 3 for the details.']);
    expect(splitCueText('Open room No. 5 now.')).toEqual(['Open room No. 5 now.']);
  });

  it('preserves a real boundary after a trailing abbreviation (Inc. Next)', () => {
    // `Inc.`/`etc.`/`Ltd.` legitimately end sentences — the title merge must not
    // swallow the following sentence.
    expect(splitCueText('It was made by Acme Inc. Next point.')).toEqual([
      'It was made by Acme Inc.',
      'Next point.',
    ]);
    expect(splitCueText('Bring pens, etc. Then leave.')).toEqual([
      'Bring pens, etc.',
      'Then leave.',
    ]);
  });

  it('keeps a lowercase continuation after an abbreviation as one cue (etc. and)', () => {
    // ICU does not split before a lowercase word, so these stay whole regardless.
    expect(splitCueText('Bring pens, etc. and then leave.')).toEqual([
      'Bring pens, etc. and then leave.',
    ]);
    expect(splitCueText('Some fruit, e.g. apples and pears.')).toEqual([
      'Some fruit, e.g. apples and pears.',
    ]);
  });

  it('treats an explicit newline as a hard boundary, even after a title', () => {
    // A newline after `Inc.` or a title ends the cue — the merge must not rejoin it.
    expect(splitCueText('Acme Inc.\nNext topic here.')).toEqual(['Acme Inc.', 'Next topic here.']);
    expect(splitCueText('Dr.\nSmith arrived later.')).toEqual(['Dr.', 'Smith arrived later.']);
  });

  it('keeps an acronym with internal periods inside one cue (U.S.)', () => {
    expect(splitCueText('The U.S. economy grew.')).toEqual(['The U.S. economy grew.']);
  });

  it('keeps a rhetorical ellipsis as one cue (under budget)', () => {
    // ICU treats `Wait... what happened?` as a single sentence; under the
    // readability budget it stays one cue rather than fragmenting on the dots.
    expect(splitCueText('Wait... what happened?')).toEqual(['Wait... what happened?']);
  });

  it('splits a semicolon-joined sentence only when over budget', () => {
    // `；` is a clause join, not a sentence end: a short one stays whole,
    // but an over-budget one breaks at the semicolon via the clause splitter.
    expect(splitCueText('前半；后半。')).toEqual(['前半；后半。']);
    const long =
      '第一段讲的是概念的基本定义和背景说明内容较多；第二段进一步展开它的应用场景和典型例子。';
    const pieces = splitCueText(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(textUnits(p)).toBeLessThanOrEqual(40);
  });

  it('still splits on a genuine sentence-ending period', () => {
    expect(splitCueText('First point. Second point.')).toEqual(['First point.', 'Second point.']);
  });
});

describe('splitCue — time distribution', () => {
  it('leaves an already-short cue unchanged (text trimmed)', () => {
    const out = splitCue(cue({ text: '  短句。 ', startMs: 1000, endMs: 4000 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startMs: 1000, endMs: 4000, text: '短句。' });
  });

  it('tiles the parent window with no gaps or overlaps', () => {
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const out = splitCue(cue({ startMs: 2000, endMs: 12_000, text }));
    expect(out.length).toBeGreaterThan(1);
    // Contiguous: each cue starts exactly where the previous ended.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMs).toBe(out[i - 1].endMs);
    }
    // Spans the whole parent window.
    expect(out[0].startMs).toBe(2000);
    expect(out[out.length - 1].endMs).toBe(12_000);
  });

  it('allocates more time to the heavier (longer) piece', () => {
    // Two separate sentences of clearly different length (both > flash floor),
    // in a window large enough that neither is merged.
    const text =
      '这是一段非常详细的说明包含很多内容和细节需要较长的时间才能朗读完毕。这是较短第二句。';
    const out = splitCue(cue({ startMs: 0, endMs: 12_000, text }));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const first = out[0].endMs - out[0].startMs;
    const last = out[out.length - 1].endMs - out[out.length - 1].startMs;
    expect(first).toBeGreaterThan(last);
  });

  it('preserves sceneId / actionId on every piece', () => {
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const out = splitCue(cue({ sceneId: 'sceneX', actionId: 'actX', text }));
    for (const c of out) {
      expect(c.sceneId).toBe('sceneX');
      expect(c.actionId).toBe('actX');
    }
  });

  it('merges a sub-1.2s sliver into a neighbour (no flashing)', () => {
    // Two sentences but a tiny window → the shorter piece would be < MIN_CUE_MS.
    const text = '第一句话讲的是概念的基本定义和背景更详细的内容。好。';
    const out = splitCue(cue({ startMs: 0, endMs: 2000, text }));
    for (const c of out) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(1200);
    }
    expect(out[out.length - 1].endMs).toBe(2000);
  });

  it('joins merged CJK pieces without a spurious space', () => {
    // A short leading sentence folds into the next; the seam is between CJK
    // glyphs, so no ASCII space should be inserted.
    const text = '好。第一句话讲的是概念的基本定义和背景更详细的内容。';
    const out = splitCue(cue({ startMs: 0, endMs: 2000, text }));
    expect(out.some((c) => c.text.includes(' '))).toBe(false);
    expect(out.map((c) => c.text).join('')).not.toContain(' ');
  });

  it('keeps a space when merging Latin pieces at a word boundary', () => {
    // Narrow (Latin) glyphs on both sides of the seam keep the word space.
    const text = 'Hi. Then we look at a much longer explanatory sentence here.';
    const out = splitCue(cue({ startMs: 0, endMs: 2000, text }));
    expect(out[0].text).toBe('Hi. Then we look at a much longer explanatory sentence here.');
  });

  it('returns the original (trimmed) cue when the window is non-positive', () => {
    const out = splitCue(cue({ startMs: 5000, endMs: 5000, text: 'a。b。c。' }));
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(5000);
    expect(out[0].endMs).toBe(5000);
  });
});

describe('splitCues — track renumbering', () => {
  it('flattens and renumbers index 0..n over the split track', () => {
    const cues = [
      cue({
        index: 0,
        startMs: 0,
        endMs: 9000,
        text: '第一句话讲的是概念的基本定义和背景说明。第二句话进一步展开它的应用场景和例子。',
      }),
      cue({ index: 1, startMs: 9000, endMs: 12_000, text: '短句。' }),
    ];
    const out = splitCues(cues);
    expect(out.length).toBeGreaterThan(cues.length);
    out.forEach((c, i) => expect(c.index).toBe(i));
    // Global timeline stays contiguous across the original cue boundary.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMs).toBeGreaterThanOrEqual(out[i - 1].startMs);
    }
  });
});
