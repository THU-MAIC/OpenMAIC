import { describe, expect, it } from 'vitest';
import { createVisibleSpeechDeltaSanitizer, sanitizeVisibleSpeech } from '@/lib/chat/pi/prompts';

describe('sanitizeVisibleSpeech', () => {
  it('removes bold, italic, heading, and code markers', () => {
    expect(sanitizeVisibleSpeech('**重点**在这里')).toBe('重点在这里');
    expect(sanitizeVisibleSpeech('这是*斜体*字')).toBe('这是斜体字');
    expect(sanitizeVisibleSpeech('## 标题\n正文')).toBe('标题\n正文');
    expect(sanitizeVisibleSpeech('用 `code` 表示')).toBe('用 code 表示');
  });

  it('strips stray markdown characters that survive paired-marker removal', () => {
    expect(sanitizeVisibleSpeech('**未闭合的加粗')).toBe('未闭合的加粗');
    expect(sanitizeVisibleSpeech('* 列表项')).toBe(' 列表项');
  });
});

describe('createVisibleSpeechDeltaSanitizer', () => {
  function runStream(deltas: string[]): string {
    const sanitize = createVisibleSpeechDeltaSanitizer();
    return deltas.map((delta) => sanitize(delta)).join('');
  }

  it('removes bold markers even when ** is split across streamed deltas', () => {
    const output = runStream(['这是', '**重', '点**', '内容']);
    expect(output).toBe('这是重点内容');
    expect(output).not.toContain('*');
  });

  it('never emits a leading marker before its closing pair arrives', () => {
    const sanitize = createVisibleSpeechDeltaSanitizer();
    // The opening "**" alone must not leak into visible speech.
    expect(sanitize('**')).not.toContain('*');
    expect(sanitize('关键')).toBe('关键');
    expect(sanitize('**')).not.toContain('*');
  });

  it('passes plain streamed text through unchanged', () => {
    expect(runStream(['你好', '，', '世界'])).toBe('你好，世界');
  });
});
