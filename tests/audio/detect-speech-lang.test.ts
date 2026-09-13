import { describe, it, expect } from 'vitest';

import { detectSpeechLang } from '@/lib/audio/browser-tts-preview';

describe('detectSpeechLang', () => {
  it('detects Chinese by CJK ratio', () => {
    expect(detectSpeechLang('光合作用是植物生长的基础')).toBe('zh-CN');
  });

  it('detects Vietnamese by decisive letters (đ/ơ/ư/ê/ô)', () => {
    expect(detectSpeechLang('Xin chào cả lớp!')).toBe('vi-VN');
    expect(detectSpeechLang('Quang hợp ở thực vật diễn ra như thế nào?')).toBe('vi-VN');
    expect(detectSpeechLang('Hôm nay thầy rất vui được đồng hành cùng các em')).toBe('vi-VN');
  });

  it('detects Vietnamese by ă/â density without decisive letters', () => {
    expect(detectSpeechLang('Anh ăn cơm với cá và canh chua')).toBe('vi-VN');
  });

  it('falls back to en-US for plain English', () => {
    expect(detectSpeechLang('Photosynthesis is how plants grow')).toBe('en-US');
    expect(detectSpeechLang('OK.')).toBe('en-US');
    expect(detectSpeechLang('')).toBe('en-US');
  });

  it('does not misclassify French as Vietnamese', () => {
    expect(detectSpeechLang('Bonjour le monde')).toBe('en-US');
    expect(detectSpeechLang('café au lait')).toBe('en-US');
  });
});
