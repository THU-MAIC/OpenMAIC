import { describe, expect, it } from 'vitest';

import { normalizeSpokenText } from '@/lib/audio/tts-text-normalize';

describe('normalizeSpokenText', () => {
  it('returns an empty string for empty input', () => {
    expect(normalizeSpokenText('')).toBe('');
  });

  it('leaves a plain sentence unchanged (no regression for math-free narration)', () => {
    const sentence = '同学们好，今天我们学习一元二次方程。';
    expect(normalizeSpokenText(sentence)).toBe(sentence);
  });

  it('turns an inline math span into spoken form without the $ delimiters', () => {
    const out = normalizeSpokenText('质能方程 $E=mc^2$ 是核心。');
    expect(out).not.toContain('$');
    expect(out).not.toContain('\\');
    expect(out).toContain('mc');
    expect(out).toContain('平方'); // exponent is spoken, not read as a caret
  });

  it('speaks a display fraction without delimiters or backslashes', () => {
    const out = normalizeSpokenText('$$\\frac{1}{2}$$');
    expect(out).not.toContain('$');
    expect(out).not.toContain('\\frac');
    expect(out).not.toContain('\\');
    expect(out).toContain('分之');
  });

  it('speaks a bare \\frac command outside any delimiter', () => {
    const out = normalizeSpokenText('概率是 \\frac{a}{b}。');
    expect(out).not.toContain('\\frac');
    expect(out).not.toContain('\\');
    expect(out).toContain('a 分之 b');
  });

  it('translates bare multiplication and comparison commands', () => {
    expect(normalizeSpokenText('\\times')).toContain('乘以');
    expect(normalizeSpokenText('\\cdot')).toContain('乘以');
    expect(normalizeSpokenText('\\leq')).toContain('小于等于');
  });

  it('speaks a subscript inside a math span', () => {
    const out = normalizeSpokenText('$x_1$');
    expect(out).not.toContain('$');
    expect(out).toContain('下标');
  });

  it('leaves a lone/currency dollar sign literal', () => {
    const text = '这个盒子的价格是 $100。';
    expect(normalizeSpokenText(text)).toBe(text);
  });

  it('does not rewrite bare prose operators or code-like tokens', () => {
    const text = '用 C++ 和 3+4 计算，占 50%。';
    expect(normalizeSpokenText(text)).toBe(text);
  });
});
