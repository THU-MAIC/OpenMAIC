// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { textSchema } from '../../../src/react/text/prosemirror/schema';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';

describe('renderer ProseMirror schema', () => {
  it('preserves explicit left alignment alongside centered paragraphs through round trips', () => {
    const html =
      '<p style="text-align:center">Heading</p><p style="text-align:left">Body</p><p>Inherited</p>';
    const doc = createTextDocument(html);
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(doc);
    expect(Array.from(host.querySelectorAll('p'), (p) => p.style.textAlign)).toEqual([
      'center',
      'left',
      '',
    ]);
    expect(createTextDocument(host.innerHTML).eq(doc)).toBe(true);
  });

  it('preserves font-measured leading spaces through editor round trips', () => {
    const html =
      '<p><span style="font-family: PingFang SC;font-size:24pt">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;苗圃维护小组</span></p>';
    const doc = createTextDocument(html);
    expect(doc.textContent).toBe('\u00a0'.repeat(10) + '苗圃维护小组');
    const output = serializeTextDocument(doc);
    expect(createTextDocument(output).textContent).toBe(doc.textContent);
  });

  it('preserves imported link styles and compact trailing punctuation', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<div style="padding:4.8px 9.6px"><p>课前调研<span style="display:inline-block;width:0.5em">：</span></p><p><a href="https://example.com" style="color:#4472C4;text-decoration:underline">link</a></p></div>',
      ),
    );
    expect(output).toContain('width: 0.5em');
    expect(output).toContain('display: inline-block');
    expect(output).toContain('rgb(68, 114, 196)');
    expect(output).toContain('text-decoration: underline');
    expect(output).toContain('padding: 4.8px 9.6px');
  });
  const column = (text: string) =>
    `<span data-pptx-tab-column="true" style="display: inline-block; width: 120px; min-width: max-content; text-align: left; text-indent: 0; white-space: pre">${text}</span>`;

  it('keeps equal adjacent PPTX tab columns and an empty column as separate editable nodes', () => {
    const doc = createTextDocument(`<p>${column('First')}${column('Second')}${column('')}</p>`);
    expect(doc.firstChild!.childCount).toBe(3);
    doc.firstChild!.forEach((node) => {
      expect(node.type.name).toBe('pptx_tab_column');
      expect(node.isAtom).toBe(false);
      expect(node.attrs.width).toBe('120px');
    });
    const output = serializeTextDocument(doc);
    const host = document.createElement('div');
    host.innerHTML = output;
    const columns = host.querySelectorAll<HTMLElement>('[data-pptx-tab-column="true"]');
    expect(Array.from(columns, (node) => node.textContent)).toEqual(['First', 'Second', '']);
    for (const node of columns) {
      expect(node.style.minWidth).toBe('max-content');
      expect(node.style.textAlign).toBe('left');
      expect(node.style.textIndent).toMatch(/^0(?:px)?$/);
      expect(node.style.whiteSpace).toBe('pre');
    }
    expect(createTextDocument(output).eq(doc)).toBe(true);
  });

  it('bolds a subset with Transform.addMark without splitting a tab column or losing run styles', () => {
    const doc = createTextDocument(
      `<p>${column('<span style="font-size: 20px; color: red; letter-spacing: 1px">A  BC</span>')}${column('Next')}</p>`,
    );
    // Transaction extends Transform: exercise its real addMark implementation.
    const tr = EditorState.create({ schema: textSchema, doc }).tr.addMark(
      5,
      6,
      textSchema.marks.strong.create(),
    );
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(tr.doc);
    const columns = host.querySelectorAll<HTMLElement>('[data-pptx-tab-column="true"]');
    expect(columns).toHaveLength(2);
    expect(columns[0].textContent).toBe('A  BC');
    expect(columns[0].querySelector('strong')?.textContent).toBe('B');
    expect(columns[0].style.width).toBe('120px');
    expect(columns[0].innerHTML).toContain('font-size: 20px');
    expect(columns[0].innerHTML).toContain('color: red');
    expect(columns[0].innerHTML).toContain('letter-spacing: 1px');
    expect(createTextDocument(host.innerHTML).eq(tr.doc)).toBe(true);
  });

  it('formats all columns without adding marks to their outer nodes', () => {
    const doc = createTextDocument(`<p>${column('A')}${column('B')}${column('')}</p>`);
    const tr = EditorState.create({ schema: textSchema, doc }).tr.addMark(
      1,
      doc.content.size - 1,
      textSchema.marks.strong.create(),
    );
    tr.doc.firstChild!.forEach((node) => {
      expect(node.marks).toHaveLength(0);
      node.forEach((text) => expect(text.marks.map((mark) => mark.type.name)).toEqual(['strong']));
    });
    expect(createTextDocument(serializeTextDocument(tr.doc)).eq(tr.doc)).toBe(true);
  });

  it('inserts text into an empty column and deletes its content without removing the column', () => {
    const doc = createTextDocument(`<p>${column('')}${column('Next')}</p>`);
    const inserted = EditorState.create({ schema: textSchema, doc }).tr.insertText('ABC', 2).doc;
    expect(inserted.firstChild!.firstChild!.textContent).toBe('ABC');
    const deleted = EditorState.create({ schema: textSchema, doc: inserted }).tr.delete(2, 5).doc;
    expect(deleted.eq(doc)).toBe(true);
  });

  it('round-trips legacy rich-text nodes and marks', () => {
    const html =
      '<blockquote><p style="text-align: center"><a href="https://maic.chat"><strong><u><span style="font-size: 28px; color: #ff0000">MAIC</span></u></strong></a></p></blockquote><ol><li><p>One</p></li></ol>';

    const output = serializeTextDocument(createTextDocument(html));

    expect(output).toContain('<blockquote>');
    expect(output).toContain('<ol');
    expect(output).toContain('font-size: 28px');
    expect(output).toContain('color: rgb(255, 0, 0)');
    expect(output).toContain('href="https://maic.chat"');
    expect(output).toContain('text-align: center');
  });

  it('preserves paragraph typography that affects line box geometry', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="font-size: 14px; line-height: 1.2">Text</p>'),
    );

    expect(output).toMatch(/<p style="[^"]*font-size: 14px/);
    expect(output).toMatch(/<p style="[^"]*line-height: 1.2/);
  });

  it('preserves PPTX character spacing and pixel first-line indentation', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p style="text-indent: 78px"><span style="letter-spacing: 1.5pt">Indented text</span></p>',
      ),
    );

    expect(output).toContain('text-indent: 78px');
    expect(output).toContain('letter-spacing: 1.5pt');
  });

  it('preserves rem first-line indentation without converting its unit', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="text-indent: 1rem">Indented text</p>'),
    );

    expect(output).toContain('text-indent: 1rem');
    expect(output).not.toContain('text-indent: 1em');
  });

  it('preserves an empty inline-block spacer used for PPTX first-line indentation', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 1.50em"></span>Indented text</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('width: 1.5em');
    expect(output).toContain('Indented text');
  });

  it('preserves PPTX text-container and paragraph geometry while editing', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<div style="padding: 4.8px 9.6px"><p style="margin-left: 78px; text-indent: -30px; padding-top: 7.3px; margin-top: 8px; margin-bottom: 5px">Text</p></div>',
      ),
    );

    expect(output).toContain('padding: 4.8px 9.6px');
    expect(output).toContain('margin-left: 78px');
    expect(output).toContain('text-indent: -30px');
    expect(output).toContain('padding-top: 7.3px');
    expect(output).toContain('margin-top: 8px');
    expect(output).toContain('margin-bottom: 5px');
  });

  it('preserves no-wrap paragraphs imported from PPTX', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="white-space: nowrap">在集体中成长，与集体共成长</p>'),
    );

    expect(output).toContain('white-space: nowrap');
  });

  it('preserves a sized inline-block slot containing a PPTX bullet glyph', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 30px; text-indent: 0; box-sizing: border-box">■</span>1954年清华大学首创</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('width: 30px');
    expect(output).toContain('text-indent: 0');
    expect(output).toContain('box-sizing: border-box');
    expect(output).toContain('■');
  });

  it('preserves inline-block layout styles used by imported PPTX text', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 30px; height: 24px; vertical-align: middle; margin: 1px 2px; padding: 3px 4px">■</span><span style="display: inline-block; width: 12px; margin-left: 5px; padding-right: 6px">•</span>Text</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('height: 24px');
    expect(output).toContain('vertical-align: middle');
    expect(output).toContain('margin: 1px 2px');
    expect(output).toContain('margin-left: 5px');
    expect(output).toContain('padding: 3px 4px');
    expect(output).toContain('padding-right: 6px');
  });

  it('preserves explicit PPTX line breaks instead of reflowing them', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="font-size: 29.3px">1954年清华大学首创“先进集体”</span><br><span style="font-size: 29.3px">评选制度</span></p>',
      ),
    );

    expect(output).toMatch(/1954年清华大学首创“先进集体”<\/span><br><span[^>]*>评选制度/);
  });

  it('turns literal plain-text newlines into explicit line breaks', () => {
    const output = serializeTextDocument(createTextDocument('First line\nSecond line'));

    expect(output).toContain('First line<br>Second line');
  });

  it('decodes plain-text HTML entities while preserving literal line breaks', () => {
    const output = serializeTextDocument(createTextDocument('A&nbsp;\nB &amp; C'));

    expect(output).toContain('A&nbsp;<br>B &amp; C');
  });
});

it('keeps font-size wrappers from adding a host-font line box', () => {
  const source =
    '<p style="line-height:1"><a href="https://example.com" style="font-family:Arial;font-size:24px;text-decoration:underline">海龟编辑器 (codemao.cn)</a></p>';
  const doc = createTextDocument(source);
  const host = document.createElement('div');
  host.innerHTML = serializeTextDocument(doc);
  const size = host.querySelector<HTMLElement>('span[style*="font-size"]')!;
  // A font-size wrapper outside the family wrapper uses the host system font.
  // Even with no direct text, that inline box shifts the Arial baseline by ~1px.
  expect(size.style.display).not.toBe('contents');
  expect(size.parentElement?.style.fontFamily.replaceAll('"', '')).toBe('Arial');
  expect(host.querySelector('a')?.textContent).toBe('海龟编辑器 (codemao.cn)');
  expect(createTextDocument(host.innerHTML).eq(doc)).toBe(true);
});

it('preserves a shared inline-block width across mixed font families', () => {
  const html =
    '<p><span style="display:inline-block;width:100px"><span style="font-family:Arial">A</span><span style="font-family:Times">B</span></span>C</p>';
  const host = document.createElement('div');
  host.innerHTML = serializeTextDocument(createTextDocument(html));
  const blocks = host.querySelectorAll<HTMLElement>('span[style*="inline-block"]');
  expect(blocks).toHaveLength(1);
  expect(blocks[0].textContent).toBe('AB');
  expect(blocks[0].style.width).toBe('100px');
});

it('preserves the font context of relative inline-block dimensions', () => {
  const html =
    '<p><span style="font-size:24px;font-family:Arial"><span style="display:inline-block;width:2em">AB</span></span>C</p>';
  const doc = createTextDocument(html);
  const host = document.createElement('div');
  host.innerHTML = serializeTextDocument(doc);
  const box = host.querySelector<HTMLElement>('span[style*="inline-block"]')!;
  expect(box.style.width).toBe('2em');
  expect(createTextDocument(host.innerHTML).eq(doc)).toBe(true);
});

it('applies relative font sizing once around an editable inline box', () => {
  const html =
    '<p><span style="font-size:2em;font-family:Arial"><span style="display:inline-block;width:2em">AB</span></span>C</p>';
  const doc = createTextDocument(html);
  const host = document.createElement('div');
  host.innerHTML = serializeTextDocument(doc);
  expect(host.querySelectorAll('span[style*="font-size"]')).toHaveLength(1);
  const box = doc.firstChild!.firstChild!;
  expect(box.type.name).toBe('inline_text_box');
  expect(box.textContent).toBe('AB');
  expect(createTextDocument(host.innerHTML).eq(doc)).toBe(true);
});

it('retains an editable inline box and its spacing after deleting its text', () => {
  const doc = createTextDocument(
    '<p><span style="display:inline-block;width:30px;height:24px;margin:2px;padding:3px">A</span></p>',
  );
  const empty = EditorState.create({ doc }).tr.delete(2, 3).doc;
  const restored = createTextDocument(serializeTextDocument(empty));
  expect(restored.eq(empty)).toBe(true);
  expect(restored.firstChild!.firstChild!.type.name).toBe('inline_text_box');
});

it.each(['', 'padding:0px;', 'padding:4px 8px;'])(
  'preserves the PPTX inset marker through editing and reopening (%s)',
  (style) => {
    const doc = createTextDocument(
      `<div data-pptx-text-insets="true" style="${style}"><p>Text</p></div>`,
    );
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.insertText('New ', 2));
    const saved = serializeTextDocument(state.doc);
    expect(saved).toContain('data-pptx-text-insets="true"');
    const reopened = createTextDocument(saved);
    expect(reopened.eq(state.doc)).toBe(true);
    expect(reopened.firstChild!.attrs.padding).toBe(doc.firstChild!.attrs.padding);
    expect(reopened.textContent).toBe('New Text');
  },
);
