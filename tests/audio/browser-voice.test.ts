/**
 * The voice a missing browser URI or the "default" sentinel speaks.
 * Discussion sets utterance.lang to zh-CN and must reserve this same voice.
 */
import { describe, expect, it } from 'vitest';

import { resolveUnmatchedBrowserVoice } from '@/lib/audio/browser-voice';

const voices = [
  { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
  { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh_CN' },
  { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
];

describe('resolveUnmatchedBrowserVoice', () => {
  it('prefers an exact lang match over the flagged default and the first voice', () => {
    expect(resolveUnmatchedBrowserVoice(voices, 'ZH-cn')?.voiceURI).toBe('uri-xiaoxiao');
  });

  it('prefers the same primary language when no tag matches exactly', () => {
    const regional = [
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
    ];
    expect(resolveUnmatchedBrowserVoice(regional, 'zh-TW')?.voiceURI).toBe('uri-xiaoxiao');
  });

  it('uses the flagged default when no language matches', () => {
    const flaggedLater = [
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
    ];
    expect(resolveUnmatchedBrowserVoice(flaggedLater, 'ja-JP')?.voiceURI).toBe('uri-david');
  });

  it('uses the first voice when nothing matches and none is default', () => {
    const unflagged = [
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US' },
    ];
    expect(resolveUnmatchedBrowserVoice(unflagged, 'ja-JP')?.voiceURI).toBe('uri-zira');
  });
});
