import { describe, it, expect } from 'vitest';
import { toSrt, toVtt, usableCues } from '@/lib/video-export';
import type { SubtitleCue } from '@/lib/video-export';

const cue = (i: number, startMs: number, endMs: number, text: string): SubtitleCue => ({
  index: i,
  sceneId: 's1',
  actionId: `a${i}`,
  startMs,
  endMs,
  text,
});

describe('subtitle serialization', () => {
  const cues: SubtitleCue[] = [
    cue(0, 0, 2500, 'Hello world'),
    cue(1, 2500, 3661_000 + 2500, 'Second line spanning past an hour'),
  ];

  it('formats SRT with 1-based indices and comma millis', () => {
    const srt = toSrt(cues);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello world\n');
    // 3661000 + 2500 ms = 01:01:03,500
    expect(srt).toContain('2\n00:00:02,500 --> 01:01:03,500\n');
    // blocks separated by a blank line
    expect(srt.split('\n\n').length).toBe(2);
  });

  it('formats WebVTT with a header and dot millis', () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500\nHello world');
    expect(vtt).not.toContain(','); // no comma separators in VTT timestamps
  });

  it('drops empty and zero/negative-span cues', () => {
    const messy: SubtitleCue[] = [
      cue(0, 0, 1000, 'kept'),
      cue(1, 1000, 1000, 'zero span'),
      cue(2, 2000, 1500, 'negative span'),
      cue(3, 3000, 4000, '   '),
    ];
    expect(usableCues(messy)).toHaveLength(1);
    const srt = toSrt(messy);
    expect(srt).toContain('kept');
    expect(srt).not.toContain('zero span');
    expect(srt).not.toContain('negative span');
    // re-numbered over the surviving cue
    expect(srt.startsWith('1\n')).toBe(true);
  });

  it('normalizes CRLF and trailing whitespace in cue text', () => {
    const srt = toSrt([cue(0, 0, 1000, 'line one\r\nline two   ')]);
    expect(srt).toContain('line one\nline two\n');
    expect(srt).not.toContain('\r');
  });

  it('emits a valid empty document when there are no cues', () => {
    expect(toSrt([])).toBe('');
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});
