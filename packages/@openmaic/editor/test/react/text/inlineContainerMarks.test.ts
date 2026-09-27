// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { DOMParser, Slice } from 'prosemirror-model';
import { buildPlugins } from '../../../src/react/text/prosemirror/plugins';
import { toggleMark } from 'prosemirror-commands';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';
import { textSchema } from '../../../src/react/text/prosemirror/schema';

const containers = [
  '<span style="display:inline-block;width:100px">ABCD</span>',
  '<span data-pptx-tab-column="true" style="display:inline-block;width:100px">ABCD</span>',
];
describe('formatting inside imported inline containers', () => {
  it.each(containers)('can unbold one character in %s', (box) => {
    const doc = createTextDocument(`<p><strong>${box}</strong>Next</p>`);
    let start = 0;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'ABCD') start = pos;
    });
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, start + 1, start + 2),
    });
    let result = doc;
    expect(
      toggleMark(textSchema.marks.strong)(state, (tr) => {
        result = tr.doc;
      }),
    ).toBe(true);
    const chars: Record<string, boolean> = {};
    result.descendants((node) => {
      if (node.isText)
        for (const char of node.text!) chars[char] = !!textSchema.marks.strong.isInSet(node.marks);
    });
    expect(chars.A).toBe(true);
    expect(chars.B).toBe(false);
    expect(chars.C).toBe(true);
    expect(result.firstChild!.firstChild!.marks).toHaveLength(0);
    expect(createTextDocument(serializeTextDocument(result)).eq(result)).toBe(true);
  });
  it('clears inherited underline and link only in the selected text', () => {
    const doc = createTextDocument(
      `<p><a href="https://example.com"><u>${containers[0]}</u></a></p>`,
    );
    const result = EditorState.create({ doc }).tr.removeMark(3, 4).doc;
    expect(result.firstChild!.firstChild!.marks).toHaveLength(0);
    const box = result.firstChild!.firstChild!;
    expect(box.child(0).marks.map((mark) => mark.type.name)).toContain('link');
    expect(box.child(1).text).toBe('B');
    expect(box.child(1).marks).toHaveLength(0);
    expect(box.child(2).marks.map((mark) => mark.type.name)).toContain('underline');
  });
});

it('normalizes clipboard slices without changing open depths', () => {
  const host = document.createElement('div');
  host.innerHTML = `<p><strong>${containers[0]}</strong></p>`;
  const raw = DOMParser.fromSchema(textSchema).parseSlice(host);
  const plugin = buildPlugins(textSchema).find((plugin) => plugin.props.transformPasted)!;
  const result = plugin.props.transformPasted!.call(plugin, raw, {} as never, false);
  expect(result).toBeInstanceOf(Slice);
  expect(result.openStart).toBe(raw.openStart);
  expect(result.openEnd).toBe(raw.openEnd);
  const box = result.content.firstChild!.firstChild!;
  expect(box.marks).toHaveLength(0);
  expect(box.firstChild!.marks.map((mark) => mark.type.name)).toContain('strong');
});

it('preserves child font overrides within nested containers', () => {
  const doc = createTextDocument(
    '<p><span style="color:red"><span style="display:inline-block;width:100px">A<span data-pptx-tab-column="true" style="display:inline-block;width:40px"><span style="color:blue">B</span>C</span></span></span></p>',
  );
  const colors: Record<string, unknown> = {};
  doc.descendants((node) => {
    if (node.isText)
      colors[node.text!] = node.marks.find((mark) => mark.type.name === 'forecolor')?.attrs.color;
  });
  expect(colors.A).toBe('red');
  expect(colors.B).toBe('blue');
  expect(colors.C).toBe('red');
});

it('keeps font context on relative-width wrappers without duplicating relative sizes', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em;font-family:Arial"><strong><span style="display:inline-block;width:2em">AB</span></strong></span></p>',
  );
  const box = doc.firstChild!.firstChild!;
  expect(box.attrs.width).toBe('2em');
  expect(box.marks.map((mark) => mark.type.name)).toEqual(['fontname', 'fontsize']);
  expect(box.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['strong']);
  expect(createTextDocument(serializeTextDocument(doc)).eq(doc)).toBe(true);
});

// Sub/sup supply an implicit smaller font size, even without a fontsize mark.
it.each(['sup', 'sub'])('keeps %s sizing outside relative-width containers', (tag) => {
  for (const container of containers) {
    const html = `<p><${tag}><strong>${container.replace('100px', '10em')}</strong></${tag}>X</p>`;
    const doc = createTextDocument(html);
    const box = doc.firstChild!.firstChild!;
    const scriptMark = tag === 'sup' ? 'superscript' : 'subscript';
    expect(box.marks.map((mark) => mark.type.name)).toEqual([scriptMark]);
    expect(box.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['strong']);
    expect(createTextDocument(serializeTextDocument(doc)).eq(doc)).toBe(true);

    const host = document.createElement('div');
    host.innerHTML = html;
    const raw = DOMParser.fromSchema(textSchema).parseSlice(host);
    const plugin = buildPlugins(textSchema).find((plugin) => plugin.props.transformPasted)!;
    const pasted = plugin.props.transformPasted!.call(plugin, raw, {} as never, false);
    expect(pasted.content.firstChild!.firstChild!.eq(box)).toBe(true);
  }
});
