import { describe, expect, it } from 'vitest';
import {
  thinkingBarPreview,
  thinkingBarSummary,
} from '@/components/workbench/chat/thinking-bar-state';

describe('thinkingBarSummary', () => {
  it('says 思考中 while streaming and 已思考 once settled', () => {
    expect(thinkingBarSummary({ streaming: true })).toBe('思考中…');
    expect(thinkingBarSummary({ streaming: true, duration: '1.2s' })).toBe('思考中…');
    expect(thinkingBarSummary({ streaming: false, duration: '3.2s' })).toBe('已思考 3.2s');
    expect(thinkingBarSummary({ streaming: false })).toBe('已思考');
  });
});

describe('thinkingBarPreview', () => {
  it('uses the newest non-empty line', () => {
    expect(thinkingBarPreview('第一步\n第二步\n\n  \n')).toBe('第二步');
  });
});
