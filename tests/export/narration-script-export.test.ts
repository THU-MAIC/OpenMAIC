import JSZip from 'jszip';
import { describe, it, expect } from 'vitest';
import {
  collectSceneScripts,
  buildMarkdown,
  buildDocxBlob,
  buildScriptFileName,
  SCRIPT_MIME_TYPES,
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

const slideFallback = (order: number) => `Slide ${order}`;

describe('collectSceneScripts', () => {
  it('omits scenes with no actions (T01)', () => {
    const scenes = [scene({ id: 'a', title: 'Empty', actions: [] })];
    expect(collectSceneScripts(scenes, slideFallback)).toEqual([]);
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
    expect(collectSceneScripts([s], slideFallback)).toEqual([
      { sceneId: 'a', sceneTitle: 'Mixed', sceneOrder: 1, text: 'First.\nSecond.' },
    ]);
  });

  it('uses scene title and preserves order (T03)', () => {
    const s = scene({ id: 'b', title: 'Titled', order: 3, actions: [speechAction('a1', 'Hi')] });
    const scripts = collectSceneScripts([s], slideFallback);
    expect(scripts[0]).toMatchObject({ sceneId: 'b', sceneTitle: 'Titled', sceneOrder: 3 });
  });

  it('omits whitespace-only speech text and trims kept text', () => {
    const wsOnly = scene({ id: 'a', title: 'WS', actions: [speechAction('a1', '   ')] });
    expect(collectSceneScripts([wsOnly], slideFallback)).toEqual([]);

    const trimmed = scene({
      id: 'b',
      title: 'Trim',
      actions: [speechAction('a1', '  Hello  ')],
    });
    expect(collectSceneScripts([trimmed], slideFallback)).toEqual([
      { sceneId: 'b', sceneTitle: 'Trim', sceneOrder: 1, text: 'Hello' },
    ]);
  });

  it('skips scenes with undefined actions without crashing', () => {
    const s = scene({ id: 'a', title: 'NoActions', actions: undefined });
    expect(collectSceneScripts([s], slideFallback)).toEqual([]);
  });

  it('falls back to the provided fallback label for empty scene titles', () => {
    const s = scene({ id: 'a', title: '', order: 3, actions: [speechAction('a1', 'Hi')] });
    expect(collectSceneScripts([s], slideFallback)).toEqual([
      { sceneId: 'a', sceneTitle: 'Slide 3', sceneOrder: 3, text: 'Hi' },
    ]);
  });

  it('invokes the fallback with the scene order and uses its return value verbatim', () => {
    const s = scene({ id: 'a', title: '', order: 5, actions: [speechAction('a1', 'Hi')] });
    const localizedFallback = (order: number) => `幻灯片 ${order}`;
    expect(collectSceneScripts([s], localizedFallback)).toEqual([
      { sceneId: 'a', sceneTitle: '幻灯片 5', sceneOrder: 5, text: 'Hi' },
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

  it('flattens embedded newlines in scene/stage titles so they cannot inject extra headings', () => {
    const md = buildMarkdown('My\nCourse', [
      { sceneId: 'a', sceneTitle: 'Evil\n# Injected Heading', sceneOrder: 1, text: 'Body.' },
    ]);
    expect(md).toContain('# My Course');
    expect(md).toContain('## Evil # Injected Heading');
    // Only the two legitimate headings (stage + scene) start a line -- the
    // embedded "# Injected Heading" no longer begins its own line, so it
    // cannot render as a heading.
    expect(md.match(/^#{1,2} /gm)?.length).toBe(2);
  });

  it('escapes (not deletes) leading # runs so they render as literal text instead of a nested heading', () => {
    const md = buildMarkdown('# Already Hash', [
      { sceneId: 'a', sceneTitle: '## Also Hash', sceneOrder: 1, text: 'Body.' },
    ]);
    // The leading # is preserved as content (teachers can legitimately title
    // something "#1 Introduction") but backslash-escaped so it can't be
    // mistaken for heading syntax by a downstream Markdown renderer.
    expect(md).toContain('# \\# Already Hash');
    expect(md).toContain('## \\#\\# Also Hash');
  });

  it('preserves a leading # even when shielded by a newline the flattening step would otherwise expose unescaped', () => {
    const md = buildMarkdown('C', [
      { sceneId: 'a', sceneTitle: '\n# Injected', sceneOrder: 1, text: 'Body.' },
    ]);
    expect(md).toContain('## \\# Injected');
    expect(md).not.toContain('## # Injected');
  });

  it('flattens lone carriage returns in stage and scene headings', () => {
    const md = buildMarkdown('My\rCourse', [
      { sceneId: 'a', sceneTitle: 'Scene\rTitle', sceneOrder: 1, text: 'Body.' },
    ]);
    expect(md).toContain('# My Course');
    expect(md).toContain('## Scene Title');
    expect(md).not.toContain('\r');
  });

  it('preserves paragraph boundaries across LF, CRLF, and lone CR narration', () => {
    const md = buildMarkdown('C', [
      {
        sceneId: 'a',
        sceneTitle: 'A',
        sceneOrder: 1,
        text: 'First line.\r\nSecond line.\r\n\r\nThird paragraph.\rFourth line.',
      },
    ]);
    expect(md).toContain('First line. Second line.');
    expect(md).toContain('First line. Second line.\n\nThird paragraph. Fourth line.');
    expect(md).not.toContain('\r');
  });
});

describe('buildDocxBlob', () => {
  it('produces a genuine OOXML document with headings and narration text', async () => {
    const blob = await buildDocxBlob('My Course', [
      { sceneId: 'a', sceneTitle: 'Intro', sceneOrder: 1, text: 'Hello world.\nSecond line.' },
    ]);
    expect(blob.size).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const documentXml = await zip.file('word/document.xml')?.async('text');
    expect(documentXml).toContain('My Course');
    expect(documentXml).toContain('Intro');
    expect(documentXml).toContain('Hello world.');
    expect(documentXml).toContain('Second line.');
  });

  it('uses the DOCX MIME and filename contract', () => {
    expect(SCRIPT_MIME_TYPES.docx).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(buildScriptFileName('My Course', 'docx')).toBe('My-Course-script.docx');
  });
});

describe('buildScriptFileName', () => {
  it('produces a safe file name with the given extension (T06)', () => {
    expect(buildScriptFileName('My Course / 101', 'md')).toBe('My-Course-101-script.md');
  });

  it('falls back to a default stem for an empty name', () => {
    expect(buildScriptFileName('', 'md')).toBe('script.md');
  });

  it('collapses repeated hyphens and trims edges', () => {
    expect(buildScriptFileName('  A  B  ', 'md')).toBe('A-B-script.md');
  });

  it('preserves ZWJ emoji sequences as a single run in file names', () => {
    expect(buildScriptFileName('Family 👨‍👩‍👧 Lesson', 'md')).toBe('Family-👨‍👩‍👧-Lesson-script.md');
  });

  it('strips control characters and falls back for all-illegal stems', () => {
    expect(buildScriptFileName('A\u0000B', 'md')).toBe('AB-script.md');
    expect(buildScriptFileName('???', 'docx')).toBe('script.docx');
  });
});
