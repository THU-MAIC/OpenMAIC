import { describe, expect, it } from 'vitest';
import {
  TTS_MAX_TEXT_LENGTH,
  splitLongSpeechActions,
  splitLongSpeechText,
} from '@/lib/audio/tts-utils';
import type { Action, SpeechAction } from '@/lib/types/action';

describe('splitLongSpeechText', () => {
  it('returns the trimmed text as a single chunk when within the limit', () => {
    expect(splitLongSpeechText('  hello world  ', 100)).toEqual(['hello world']);
  });

  it('returns a single (empty) chunk for blank input', () => {
    expect(splitLongSpeechText('   ', 100)).toEqual(['']);
  });

  it('splits at sentence-ending punctuation', () => {
    const chunks = splitLongSpeechText('第一句。第二句。第三句。', 6);
    // Each sentence ("第一句。") is 4 chars, so packing two would exceed 6.
    expect(chunks).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  it('packs consecutive short sentences up to the limit', () => {
    const chunks = splitLongSpeechText('甲。乙。丙。丁。', 4);
    // Units are 2 chars each; pack two per chunk (4 <= 4).
    expect(chunks).toEqual(['甲。乙。', '丙。丁。']);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4);
  });

  it('falls back to clause-level punctuation when a sentence exceeds the limit', () => {
    const chunks = splitLongSpeechText('前半部分，后半部分。', 6);
    // The single sentence is too long, so it splits on the comma.
    expect(chunks).toEqual(['前半部分，', '后半部分。']);
  });

  it('hard-splits a punctuation-free run at maxLength', () => {
    const chunks = splitLongSpeechText('abcdefghij', 4);
    expect(chunks).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps every chunk within maxLength and non-empty for adversarial inputs', () => {
    const inputs = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '短句。' + '长'.repeat(50) + '，' + '尾'.repeat(50) + '。',
      'no punctuation at all just a long english sentence that keeps going',
      '混合mixed内容content，with标点。and english！结尾',
      '。'.repeat(20),
    ];
    for (const maxLength of [3, 5, 10, 17]) {
      for (const input of inputs) {
        const chunks = splitLongSpeechText(input, maxLength);
        for (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          expect(chunk.length).toBeLessThanOrEqual(maxLength);
        }
      }
    }
  });
});

describe('splitLongSpeechActions', () => {
  const speech = (over: Partial<SpeechAction> = {}): SpeechAction => ({
    type: 'speech',
    id: 'act1',
    text: 'short narration',
    ...over,
  });

  it('returns the input untouched for providers with no length limit', () => {
    const actions: Action[] = [speech({ text: 'x'.repeat(5000) })];
    // 'glm-tts' is the only capped provider; a custom id has no limit.
    const result = splitLongSpeechActions(actions, 'custom-tts-none');
    expect(result).toBe(actions);
  });

  it('leaves short speech and non-speech actions unchanged', () => {
    const actions: Action[] = [
      speech({ id: 's', text: 'tiny' }),
      { type: 'spotlight', id: 'sp', elementId: 'el-1' },
    ];
    const result = splitLongSpeechActions(actions, 'glm-tts');
    expect(result).toBe(actions);
  });

  it('does not split when the provider limit is not exceeded', () => {
    const limit = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const actions: Action[] = [speech({ text: '内容。'.repeat(10) })];
    expect(speech({ text: '内容。'.repeat(10) }).text.length).toBeLessThanOrEqual(limit);
    expect(splitLongSpeechActions(actions, 'glm-tts')).toBe(actions);
  });

  it('chunks an over-limit speech action into ordered sub-actions', () => {
    const limit = TTS_MAX_TEXT_LENGTH['glm-tts']!; // 1024
    // 400 * 3 chars = 1200 > 1024, no spaces so trimming is a no-op.
    const text = '内容。'.repeat(400);
    const original = speech({
      id: 'lecture',
      text,
      audioId: 'audio-xyz',
      voice: 'female-1',
      speed: 1.2,
    });

    const result = splitLongSpeechActions([original], 'glm-tts') as SpeechAction[];

    expect(result.length).toBeGreaterThan(1);
    // Sub-action ids follow the `${id}_tts_${n}` contract, 1-based.
    result.forEach((sub, i) => {
      expect(sub.id).toBe(`lecture_tts_${i + 1}`);
      expect(sub.type).toBe('speech');
      // Parent audioId is dropped so each chunk gets its own audio file.
      expect('audioId' in sub).toBe(false);
      // Other speech fields are preserved on every sub-action.
      expect(sub.voice).toBe('female-1');
      expect(sub.speed).toBe(1.2);
      expect(sub.text.length).toBeLessThanOrEqual(limit);
      expect(sub.text.length).toBeGreaterThan(0);
    });
    // No text is lost across the split.
    expect(result.map((sub) => sub.text).join('')).toBe(text);
  });
});
