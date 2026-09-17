// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state';
import { executeTextCommand } from '../../../src/react/text/commandExecutor';
import { getMarkAttrs } from '../../../src/react/text/prosemirror/utils';
import { undo, redo } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';
import { textSchema } from '../../../src/react/text/prosemirror/schema';
import { buildKeymap } from '../../../src/react/text/prosemirror/plugins/keymap';
import { buildPlugins } from '../../../src/react/text/prosemirror/plugins';

it.each(['sup', 'sub'])('can cancel %s on selected or newly typed text', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const key = tag === 'sup' ? 'Mod-;' : "Mod-'";
  for (const end of [3, 4]) {
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, end) });
    expect(
      buildKeymap(textSchema)[key](state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    if (end === 3) state = state.apply(state.tr.insertText('Q'));
    const html = document.createElement('div');
    html.innerHTML = serializeTextDocument(state.doc);
    expect(
      Array.from(html.querySelectorAll(tag))
        .map((el) => el.textContent)
        .join(''),
    ).toBe(end === 3 ? 'ABCD' : 'ACD');
    expect(html.querySelector(`${tag} ${tag}`)).toBeNull();
  }
});

it.each(['sup', 'sub'])('retains %s when copying only inner text', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const source = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  const targetDoc = createTextDocument('<p>YZ</p>');
  const target = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc: targetDoc,
      selection: TextSelection.create(targetDoc, 2),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    target.pasteHTML(
      source.serializeForClipboard(source.state.selection.content()).dom.innerHTML,
      {} as ClipboardEvent,
    );
    expect(serializeTextDocument(target.state.doc)).toContain(`<${tag}>B</${tag}>`);
  } finally {
    source.destroy();
    target.destroy();
  }
});

it('retains bold font metrics for ch dimensions', () => {
  const doc = createTextDocument(
    '<p><strong><span style="display:inline-block;width:10ch">ABCD</span></strong>X</p>',
  );
  expect(textSchema.marks.strong.isInSet(doc.firstChild!.firstChild!.marks)).toBeTruthy();
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 4) });
  buildKeymap(textSchema)['Mod-b'](state, (tr) => {
    state = state.apply(tr);
  });
  const html = document.createElement('div');
  html.innerHTML = serializeTextDocument(state.doc);
  expect(
    Array.from(html.querySelectorAll('strong'))
      .map((el) => el.textContent)
      .join(''),
  ).toBe('ACD');
});

it('keeps formatting changes in one undo step and preserves whole copied boxes', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup>X</p>',
  );
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 3, 4),
    plugins: buildPlugins(textSchema),
  });
  const dispatch = (tr: Parameters<typeof state.apply>[0]) => {
    state = state.apply(tr);
  };
  buildKeymap(textSchema)['Mod-;'](state, dispatch);
  const edited = state.doc;
  expect(undo(state, dispatch)).toBe(true);
  expect(state.doc.eq(doc)).toBe(true);
  expect(redo(state, dispatch)).toBe(true);
  expect(state.doc.eq(edited)).toBe(true);

  const slice = TextSelection.create(doc, 1, 7).content();
  const plugin = buildPlugins(textSchema).find((p) => p.props.transformCopied)!;
  const copied = plugin.props.transformCopied!.call(plugin, slice, {} as never);
  expect(copied.eq(slice)).toBe(true);
});

it('reports inherited toolbar formatting and clears only the selected character', () => {
  const doc = createTextDocument(
    '<p><strong><span style="display:inline-block;width:10ch">ABCD</span></strong></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    expect(getMarkAttrs(view).some((mark) => mark.type.name === 'strong')).toBe(true);
    executeTextCommand(view, { command: 'clear' });
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(view.state.doc);
    expect(
      Array.from(host.querySelectorAll('strong'))
        .map((el) => el.textContent)
        .join(''),
    ).toBe('ACD');
  } finally {
    view.destroy();
  }
});

it.each(['sup', 'sub'])('does not duplicate %s when pasting back into its source box', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const copied = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    view.pasteHTML(copied, {} as ClipboardEvent);
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(view.state.doc);
    expect(host.textContent).toBe('ABCBD');
    expect(host.querySelector(`${tag} ${tag}`)).toBeNull();
    expect(host.querySelector(tag)?.textContent).toBe('ABCBD');
  } finally {
    view.destroy();
  }
});

it('preserves nested relative font contexts when clearing a sibling', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em"><span style="display:inline-block;width:10em">AB<span style="font-size:0.5em"><span style="display:inline-block;width:3em">CD</span></span>EF</span></span></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2, 3),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    executeTextCommand(view, { command: 'clear' });
    const outer = view.state.doc.firstChild!.firstChild!;
    expect(outer.marks.find((mark) => mark.type.name === 'fontsize')?.attrs.fontsize).toBe('2em');
    const inner = outer.child(1);
    expect(inner.marks.find((mark) => mark.type.name === 'fontsize')?.attrs.fontsize).toBe('0.5em');
    expect(inner.textContent).toBe('CD');
  } finally {
    view.destroy();
  }
});

it('keeps a complete pasted box independent of the destination script context', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const slice = doc.slice(1, 7);
    const plugin = buildPlugins(textSchema).find((p) => p.props.transformPasted)!;
    expect(plugin.props.transformPasted!.call(plugin, slice, view, false).eq(slice)).toBe(true);
    expect(plugin.props.handlePaste!.call(plugin, view, {} as ClipboardEvent, slice)).toBe(false);
  } finally {
    view.destroy();
  }
});

it('does not strip script formatting in the shared paste/drop conversion hook', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const plugin = buildPlugins(textSchema).find((p) => p.props.transformPasted)!;
    const copied = plugin.props.transformCopied!.call(plugin, view.state.selection.content(), view);
    const transformed = plugin.props.transformPasted!.call(plugin, copied, view, false);
    let scripted = false;
    transformed.content.descendants((node) => {
      if (node.isText && textSchema.marks.superscript.isInSet(node.marks)) scripted = true;
    });
    expect(scripted).toBe(true);
  } finally {
    view.destroy();
  }
});

it('copies relative font sizes as rendered sizes before inserting into another font context', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em"><span style="display:inline-block;width:10em">ABCD</span></span></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  document.body.append(view.dom);
  try {
    // jsdom has no relative-unit layout; provide the browser-resolved size on
    // the rendered box while retaining 2em in the document being copied.
    (view.dom.querySelector('[data-inline-text-box]') as HTMLElement).style.fontSize = '32px';
    const copied = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    expect(copied).toContain('font-size: 32px');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    view.pasteHTML(copied, {} as ClipboardEvent);
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(view.state.doc);
    expect(
      host.querySelector('[data-inline-text-box] [style*="font-size: 32px"]')?.textContent,
    ).toBe('B');
  } finally {
    view.dom.remove();
    view.destroy();
  }
});

it('measures the selected run at a font-size boundary', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em"><span style="display:inline-block;width:10em">A<span style="font-size:0.5em">BC</span>D</span></span></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  document.body.append(view.dom);
  try {
    const box = view.dom.querySelector('[data-inline-text-box]') as HTMLElement;
    box.style.fontSize = '32px';
    (box.querySelector('span') as HTMLElement).style.fontSize = '16px';
    const copied = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    expect(copied).toContain('font-size: 16px');
    expect(copied).not.toContain('font-size: 32px');
  } finally {
    view.dom.remove();
    view.destroy();
  }
});

it('compensates absolute child sizes when carrying script formatting', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em"><sup><span style="display:inline-block;width:10em">A<span style="font-size:20px">BC</span>D</span></sup></span></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  document.body.append(view.dom);
  try {
    const script = view.dom.querySelector('sup') as HTMLElement;
    script.style.fontSize = '24px';
    script.parentElement!.style.fontSize = '32px';
    const copied = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    expect(copied).toContain('font-size: 26.6667px');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 5)));
    view.pasteHTML(copied, {} as ClipboardEvent);
    expect(serializeTextDocument(view.state.doc)).toContain('font-size: 20px');
  } finally {
    view.dom.remove();
    view.destroy();
  }
});

it.each(['caret', 'all', 'cross-container'])(
  'preserves container font contexts when clearing a %s selection',
  (mode) => {
    const doc = createTextDocument(
      '<p><span style="font-family:Arial;font-size:2em"><span style="display:inline-block;width:10em"><strong>A</strong><span style="font-family:Georgia;font-size:0.5em"><span style="display:inline-block;width:3em"><span style="font-family:Verdana;font-size:12px;color:red">BC</span></span></span>D</span></span><span style="font-size:18px">E</span></p>',
    );
    const selection =
      mode === 'all'
        ? new AllSelection(doc)
        : TextSelection.create(doc, 2, mode === 'caret' ? 2 : doc.content.size - 1);
    const view = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc, selection, plugins: buildPlugins(textSchema) }),
    });
    try {
      executeTextCommand(view, { command: 'clear' });
      const outer = view.state.doc.firstChild!.firstChild!;
      const inner = outer.child(1);
      expect(outer.marks.find((m) => m.type.name === 'fontsize')?.attrs.fontsize).toBe('2em');
      expect(outer.marks.find((m) => m.type.name === 'fontname')?.attrs.fontname).toBe('Arial');
      expect(inner.marks.find((m) => m.type.name === 'fontsize')?.attrs.fontsize).toBe('0.5em');
      expect(inner.marks.find((m) => m.type.name === 'fontname')?.attrs.fontname).toBe('Georgia');
      expect(outer.attrs.width).toBe('10em');
      expect(inner.attrs.width).toBe('3em');
      view.state.doc.descendants((node) => {
        if (node.isText) expect(node.marks).toEqual([]);
      });
      expect(view.state.doc.textContent).toBe('ABCDE');
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.toJSON()).toEqual(doc.toJSON());
    } finally {
      view.destroy();
    }
  },
);

it.each(['inline_text_box', 'pptx_tab_column'])(
  'preserves %s font context through font changes and undo/redo',
  (containerType) => {
    for (const command of ['fontsize', 'fontname'] as const) {
      for (const mode of ['partial', 'all', 'caret']) {
        const base = createTextDocument(
          '<p><span style="font-family:Arial;font-size:2em"><span style="display:inline-block;width:10em">ABCD</span></span>X</p>',
        );
        const box = base.firstChild!.firstChild!;
        const container = textSchema.nodes[containerType].create(box.attrs, box.content, box.marks);
        const doc = textSchema.nodes.doc.create(
          null,
          textSchema.nodes.paragraph.create(null, [container, textSchema.text('X')]),
        );
        const selection =
          mode === 'all'
            ? new AllSelection(doc)
            : TextSelection.create(doc, 3, mode === 'caret' ? 3 : 4);
        const view = new EditorView(document.createElement('div'), {
          state: EditorState.create({ doc, selection, plugins: buildPlugins(textSchema) }),
        });
        try {
          const value = command === 'fontsize' ? '30px' : 'Georgia';
          executeTextCommand(view, { command, value });
          const edited = view.state.doc;
          expect(edited.firstChild!.firstChild!.marks).toEqual(container.marks);
          expect(edited.firstChild!.firstChild!.attrs).toEqual(container.attrs);
          const runs: { text: string; value: string | undefined }[] = [];
          edited.descendants((node) => {
            if (node.isText)
              runs.push({
                text: node.text!,
                value: node.marks.find((m) => m.type.name === command)?.attrs[command],
              });
          });
          expect(
            runs
              .filter((run) => run.value === value)
              .map((run) => run.text)
              .join(''),
          ).toBe(mode === 'partial' ? 'B' : 'ABCDX');
          expect(undo(view.state, view.dispatch)).toBe(true);
          expect(view.state.doc.eq(doc)).toBe(true);
          expect(redo(view.state, view.dispatch)).toBe(true);
          expect(view.state.doc.eq(edited)).toBe(true);
        } finally {
          view.destroy();
        }
      }
    }
  },
);
