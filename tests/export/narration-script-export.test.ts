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
});
