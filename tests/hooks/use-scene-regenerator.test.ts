import { describe, it, expect } from 'vitest';
import {
  outlineToIndication,
  indicationToOutline,
  buildMediaGenerations,
  applyAudioOverride,
} from '@/lib/hooks/use-scene-regenerator';
import type { SpeechAction } from '@/lib/types/action';

describe('outlineToIndication', () => {
  it('joins description and key points with bullets', () => {
    const result = outlineToIndication('Intro to React', ['components', 'props']);
    expect(result).toBe('Intro to React\n• components\n• props');
  });

  it('returns only description when no key points', () => {
    expect(outlineToIndication('Just a description', [])).toBe('Just a description');
  });
});

describe('indicationToOutline', () => {
  it('parses bullets as keyPoints and plain lines as description', () => {
    const result = indicationToOutline('Intro to React\n• components\n• props');
    expect(result.description).toBe('Intro to React');
    expect(result.keyPoints).toEqual(['components', 'props']);
  });

  it('handles indication with no bullets', () => {
    const result = indicationToOutline('Plain description only');
    expect(result.description).toBe('Plain description only');
    expect(result.keyPoints).toEqual([]);
  });
});

describe('buildMediaGenerations', () => {
  it('returns empty array for none', () => {
    expect(buildMediaGenerations('none')).toEqual([]);
  });

  it('returns image entry with gen_img_1 elementId', () => {
    const result = buildMediaGenerations('image', 'A React diagram');
    expect(result[0].elementId).toBe('gen_img_1');
    expect(result[0].type).toBe('image');
    expect(result[0].prompt).toBe('A React diagram');
  });

  it('returns video entry with gen_vid_1 elementId', () => {
    const result = buildMediaGenerations('video', 'Animation showing React');
    expect(result[0].elementId).toBe('gen_vid_1');
    expect(result[0].type).toBe('video');
  });
});

describe('applyAudioOverride', () => {
  it('maps segments to speech actions by index', () => {
    const actions = [
      { type: 'spotlight', id: 's1' },
      { type: 'speech', text: 'original 1', id: 'sp1' },
      { type: 'speech', text: 'original 2', id: 'sp2' },
    ] as Array<{ type: string; text?: string; id: string }>;
    const result = applyAudioOverride(
      actions as Parameters<typeof applyAudioOverride>[0],
      'new segment 1\n\nnew segment 2',
    );
    expect((result[1] as SpeechAction).text).toBe('new segment 1');
    expect((result[2] as SpeechAction).text).toBe('new segment 2');
  });

  it('keeps AI text when user provides fewer segments than actions', () => {
    const actions = [
      { type: 'speech', text: 'original 1', id: 'sp1' },
      { type: 'speech', text: 'original 2', id: 'sp2' },
    ] as Parameters<typeof applyAudioOverride>[0];
    const result = applyAudioOverride(actions, 'only one segment');
    expect((result[0] as SpeechAction).text).toBe('only one segment');
    expect((result[1] as SpeechAction).text).toBe('original 2');
  });
});
