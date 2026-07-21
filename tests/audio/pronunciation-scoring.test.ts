import { describe, expect, it } from 'vitest';
import { scorePronunciation } from '@/lib/audio/pronunciation-scoring';

describe('scorePronunciation', () => {
  it('gives a high score to an exact transcript even without confidence', () => {
    expect(scorePronunciation('Three green trees', 'three green trees').score).toBe(100);
  });

  it('does not let a clearly wrong phrase pass as correct', () => {
    expect(scorePronunciation('Three green trees', 'free cream cheese').score).toBeLessThan(45);
  });

  it('keeps later words aligned when one word is omitted', () => {
    const result = scorePronunciation('I would like a cup of tea', 'I would like cup of tea');
    expect(result.matchedWords).toBe(6);
    expect(result.score).toBeGreaterThan(75);
  });

  it('rejects empty or silent attempts', () => {
    expect(scorePronunciation('hello world', '').score).toBe(0);
  });
});
