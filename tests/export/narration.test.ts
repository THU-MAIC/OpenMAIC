import { describe, it, expect } from 'vitest';
import { collectSpeechText } from '@/lib/export/narration';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';

function speechAction(id: string, text: string): SpeechAction {
  return { id, type: 'speech', text };
}

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    stageId: 'stg1',
    title: 'Scene One',
    order: 1,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: { width: 960, height: 540, elements: [] },
      animations: [],
    },
    actions: [],
    ...overrides,
  } as unknown as Scene;
}

describe('collectSpeechText', () => {
  it('returns an empty string for a scene with no actions', () => {
    expect(collectSpeechText(scene({ actions: [] }))).toBe('');
  });

  it('returns an empty string for a scene with undefined actions', () => {
    expect(collectSpeechText(scene({ actions: undefined }))).toBe('');
  });

  it('tolerates a missing scene', () => {
    expect(collectSpeechText(null)).toBe('');
    expect(collectSpeechText(undefined)).toBe('');
  });

  it('collects only speech text, in action order', () => {
    const s = scene({
      actions: [
        speechAction('a1', 'First.'),
        { id: 'a2', type: 'spotlight', elementId: 'e1' },
        speechAction('a3', 'Second.'),
        { id: 'a4', type: 'wb_draw_text', content: 'board', x: 0, y: 0 },
      ],
    });
    expect(collectSpeechText(s)).toBe('First.\nSecond.');
  });

  it('keeps whitespace-only speech by default (PPTX behaviour)', () => {
    const s = scene({ actions: [speechAction('a1', '   ')] });
    expect(collectSpeechText(s)).toBe('   ');
  });

  it('drops whitespace-only speech with keepWhitespaceOnly: false (script behaviour)', () => {
    const s = scene({ actions: [speechAction('a1', '   '), speechAction('a2', 'Kept')] });
    expect(collectSpeechText(s, { keepWhitespaceOnly: false })).toBe('Kept');
  });

  it('drops empty-string speech with keepWhitespaceOnly: false', () => {
    const s = scene({ actions: [speechAction('a1', ''), speechAction('a2', 'Kept')] });
    expect(collectSpeechText(s, { keepWhitespaceOnly: false })).toBe('Kept');
  });

  it('does not trim parts by default (PPTX behaviour)', () => {
    const s = scene({ actions: [speechAction('a1', '  Hello  ')] });
    expect(collectSpeechText(s)).toBe('  Hello  ');
  });

  it('trims each part with trim: true (script behaviour)', () => {
    const s = scene({ actions: [speechAction('a1', '  Hello  ')] });
    expect(collectSpeechText(s, { trim: true })).toBe('Hello');
  });

  it('trims each part independently, preserving the join', () => {
    const s = scene({ actions: [speechAction('a1', ' one '), speechAction('a2', ' two ')] });
    expect(collectSpeechText(s, { trim: true })).toBe('one\ntwo');
  });

  it('applies the script options together', () => {
    const s = scene({
      actions: [speechAction('a1', '   '), speechAction('a2', '  Hello  ')],
    });
    expect(collectSpeechText(s, { keepWhitespaceOnly: false, trim: true })).toBe('Hello');
  });

  it('keeps internal newlines and blank lines inside a single speech part', () => {
    const s = scene({ actions: [speechAction('a1', 'Line one.\n\nLine two.')] });
    expect(collectSpeechText(s)).toBe('Line one.\n\nLine two.');
  });

  it('joins multiple speech parts with a single newline, not a blank line', () => {
    const s = scene({ actions: [speechAction('a1', 'A'), speechAction('a2', 'B')] });
    expect(collectSpeechText(s)).toBe('A\nB');
  });
});
