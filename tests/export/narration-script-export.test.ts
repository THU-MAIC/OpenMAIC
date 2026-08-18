import { describe, it, expect } from 'vitest';
import {
  collectSceneScripts,
  buildMarkdown,
  buildDocHtml,
  buildScriptFileName,
} from '@/lib/export/use-export-script';
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

describe('collectSceneScripts', () => {
  it('omits scenes with no actions (T01)', () => {
    const scenes = [scene({ id: 'a', title: 'Empty', actions: [] })];
    expect(collectSceneScripts(scenes)).toEqual([]);
  });

  it('collects only speech text in action order (T02)', () => {
    const s = scene({
      id: 'a',
      title: 'Mixed',
      actions: [
        speechAction('a1', 'First.'),
        { id: 'a2', type: 'spotlight', elementId: 'e1' },
        speechAction('a3', 'Second.'),
        { id: 'a4', type: 'wb_draw_text', content: 'board', x: 0, y: 0 },
      ],
    });
    expect(collectSceneScripts([s])).toEqual([
      { sceneId: 'a', sceneTitle: 'Mixed', sceneOrder: 1, text: 'First.\nSecond.' },
    ]);
  });

  it('uses scene title and preserves order (T03)', () => {
    const s = scene({ id: 'b', title: 'Titled', order: 3, actions: [speechAction('a1', 'Hi')] });
    const scripts = collectSceneScripts([s]);
    expect(scripts[0]).toMatchObject({ sceneId: 'b', sceneTitle: 'Titled', sceneOrder: 3 });
  });

  it('omits whitespace-only speech text and trims kept text', () => {
    const wsOnly = scene({ id: 'a', title: 'WS', actions: [speechAction('a1', '   ')] });
    expect(collectSceneScripts([wsOnly])).toEqual([]);

    const trimmed = scene({
      id: 'b',
      title: 'Trim',
      actions: [speechAction('a1', '  Hello  ')],
    });
    expect(collectSceneScripts([trimmed])).toEqual([
      { sceneId: 'b', sceneTitle: 'Trim', sceneOrder: 1, text: 'Hello' },
    ]);
  });

  it('skips scenes with undefined actions without crashing', () => {
    const s = scene({ id: 'a', title: 'NoActions', actions: undefined });
    expect(collectSceneScripts([s])).toEqual([]);
  });

  it('falls back to Slide N for empty scene titles', () => {
    const s = scene({ id: 'a', title: '', order: 3, actions: [speechAction('a1', 'Hi')] });
    expect(collectSceneScripts([s])).toEqual([
      { sceneId: 'a', sceneTitle: 'Slide 3', sceneOrder: 3, text: 'Hi' },
    ]);
  });
});

describe('buildMarkdown', () => {
  it('renders stage heading, scene headings, and paragraphs (T04)', () => {
    const md = buildMarkdown('My Course', [
      { sceneId: 'a', sceneTitle: 'Intro', sceneOrder: 1, text: 'Line one.\n\nLine two.' },
      { sceneId: 'b', sceneTitle: 'Deep Dive', sceneOrder: 2, text: 'Second scene.' },
    ]);
    expect(md).toContain('# My Course');
    expect(md).toContain('## Intro');
    expect(md).toContain('Line one.\n\nLine two.');
    expect(md).toContain('## Deep Dive');
    expect(md).toContain('Second scene.');
  });

  it('collapses single newlines inside a paragraph to spaces (T04)', () => {
    const md = buildMarkdown('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'Line one.\nLine two.' },
    ]);
    expect(md).toContain('Line one. Line two.');
  });

  it('skips empty scripts in markdown (T04)', () => {
    const md = buildMarkdown('C', [{ sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: '' }]);
    expect(md).toBe('# C');
  });

  it('filters whitespace-only paragraphs and collapses trailing blank lines', () => {
    const md = buildMarkdown('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'Hello\n\n   \n\nWorld' },
    ]);
    // The whitespace-only paragraph is dropped, so Hello and World are
    // consecutive paragraphs with no blank filler between them.
    expect(md).toBe('# C\n\n## A\n\nHello\n\nWorld');

    const trailing = buildMarkdown('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'Only.\n\n\n' },
    ]);
    expect(trailing).toBe('# C\n\n## A\n\nOnly.');
  });
});

describe('buildDocHtml', () => {
  it('renders a minimal HTML document with h1/h2/p structure (T05)', () => {
    const html = buildDocHtml('My Course', [
      { sceneId: 'a', sceneTitle: 'Intro', sceneOrder: 1, text: 'Hello world.' },
    ]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<h1>My Course</h1>');
    expect(html).toContain('<h2>Intro</h2>');
    expect(html).toContain('<p>Hello world.</p>');
  });

  it('escapes <, >, & in speech text so the HTML stays valid (T05)', () => {
    const html = buildDocHtml('Math', [
      { sceneId: 'a', sceneTitle: 'Inequality', sceneOrder: 1, text: 'a<b and c>d & more' },
    ]);
    expect(html).toContain('a&lt;b and c&gt;d &amp; more');
    expect(html).not.toContain('a<b');
  });

  it('skips empty and whitespace-only paragraphs in HTML', () => {
    const html = buildDocHtml('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'Line one.\n\n   \n\nLine two.' },
    ]);
    expect(html).toContain('<p>Line one.</p>');
    expect(html).toContain('<p>Line two.</p>');
    expect(html).not.toContain('<p></p>');
    expect(html).not.toContain('<p>   </p>');
  });

  it('does not emit a trailing empty paragraph for trailing newlines', () => {
    const html = buildDocHtml('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'A\n\n' },
    ]);
    expect(html).toContain('<p>A</p>');
    expect(html).not.toContain('<p></p>');
  });

  it('renders single newlines inside a paragraph as <br>', () => {
    const html = buildDocHtml('C', [
      { sceneId: 'a', sceneTitle: 'A', sceneOrder: 1, text: 'Line one.\nLine two.' },
    ]);
    expect(html).toContain('<p>Line one.<br>Line two.</p>');
  });
});

describe('buildScriptFileName', () => {
  it('produces a safe file name with the given extension (T06)', () => {
    expect(buildScriptFileName('My Course / 101', 'md')).toBe('My-Course-101-script.md');
  });

  it('falls back to a default stem for an empty name', () => {
    expect(buildScriptFileName('', 'doc')).toBe('script.doc');
  });

  it('collapses repeated hyphens and trims edges', () => {
    expect(buildScriptFileName('  A  B  ', 'md')).toBe('A-B-script.md');
  });

  it('preserves ZWJ emoji sequences as a single run in file names', () => {
    expect(buildScriptFileName('Family 👨‍👩‍👧 Lesson', 'md')).toBe('Family-👨‍👩‍👧-Lesson-script.md');
  });

  it('strips control characters and falls back for all-illegal stems', () => {
    expect(buildScriptFileName('A\u0000B', 'md')).toBe('AB-script.md');
    expect(buildScriptFileName('???', 'doc')).toBe('script.doc');
  });
});
