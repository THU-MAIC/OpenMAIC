/**
 * The composer's document and its plain string: the mapping every caller relies
 * on, and the rule for which runs are chips. No view and no DOM.
 */
import { history, redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import {
  composerSchema,
  composerTextRuns,
  docFromPlain,
  normalizeComposerDoc,
  offsetOfPos,
  plainOfDoc,
  plainOfSlice,
  posOfOffset,
  replaceComposerDoc,
  sliceOfPlainText,
  type ComposerChipSource,
} from '@/lib/workbench/composer-doc';

const course = {
  label: '@Fractions',
  kind: 'course',
  id: 'stage-1',
  name: 'Fractions, the whole unit',
} as const;
const source: ComposerChipSource = {
  skills: new Map([['deep-interactive', '深度交互']]),
  mentions: new Map([[course.label, course]]),
  mentionIcon: () => 'course',
};

const stateOf = (text: string, caret?: number) => {
  const state = EditorState.create({
    schema: composerSchema,
    doc: docFromPlain(text, source),
    plugins: [history()],
  });
  if (caret === undefined) return state;
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, posOfOffset(state.doc, caret))),
  );
};

const chips = (doc: EditorState['doc']) => {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'chip') found.push(`${node.attrs.kind}:${node.attrs.label}`);
  });
  return found;
};

describe('the string and the document', () => {
  it.each([
    '',
    'plain',
    '/deep-interactive make it',
    'see @Fractions now',
    'two\nlines',
    '\n\nblank lines\n',
    '/deep-interactive a\n@Fractions b\n中文',
  ])('round-trips %j', (text) => {
    expect(plainOfDoc(docFromPlain(text, source))).toBe(text);
  });

  it('draws a handle and a mention as chips, with what they are called', () => {
    expect(chips(docFromPlain('/deep-interactive see @Fractions', source))).toEqual([
      'skill:深度交互',
      'course:Fractions, the whole unit',
    ]);
  });

  it('leaves what does not resolve as text', () => {
    for (const text of ['/deep-interactive2', '/other', '@Unknown', 'a/deep-interactive']) {
      expect(chips(docFromPlain(text, source))).toEqual([]);
    }
  });

  it('maps every offset to a position and back', () => {
    const text = '/deep-interactive a\n@Fractions b';
    const doc = docFromPlain(text, source);
    const handle = '/deep-interactive'.length;
    const label = '@Fractions'.length;
    for (const offset of [0, handle, handle + 1, handle + 2, handle + 3, handle + 3 + label]) {
      expect(offsetOfPos(doc, posOfOffset(doc, offset))).toBe(offset);
    }
    expect(offsetOfPos(doc, doc.content.size)).toBe(text.length);
  });

  it('puts an offset inside a chip after the chip', () => {
    const doc = docFromPlain('/deep-interactive a', source);
    expect(offsetOfPos(doc, posOfOffset(doc, 5))).toBe('/deep-interactive'.length);
  });

  it('spells a selection across chips and lines as the string does', () => {
    const doc = docFromPlain('/deep-interactive a\n@Fractions b', source);
    expect(plainOfSlice(doc.slice(1, doc.content.size - 1))).toBe(
      '/deep-interactive a\n@Fractions b',
    );
    expect(plainOfSlice(doc.slice(1, 3))).toBe('/deep-interactive ');
  });

  it('takes pasted text as lines, nothing more', () => {
    expect(plainOfSlice(sliceOfPlainText('one\r\ntwo\n'))).toBe('one\ntwo\n');
    expect(sliceOfPlainText('').size).toBe(0);
  });
});

describe('a text that is only shown', () => {
  it('cuts into the same chips the input draws, and joins back to itself', () => {
    const text = '/deep-interactive a\n@Fractions /deep-interactive2';
    const runs = composerTextRuns(text, source);
    expect(runs.map((run) => run.text).join('')).toBe(text);
    expect(runs.flatMap((run) => (run.chip ? [run.chip.label] : []))).toEqual([
      '深度交互',
      'Fractions, the whole unit',
    ]);
  });
});

describe('the chip rule', () => {
  const typed = (text: string) =>
    EditorState.create({
      schema: composerSchema,
      doc: composerSchema.nodes.doc!.create(null, [
        composerSchema.nodes.paragraph!.create(null, text ? composerSchema.text(text) : undefined),
      ]),
    });

  it('leaves a handle under the caret as text until the caret leaves it', () => {
    const state = typed('/deep-interactive');
    expect(normalizeComposerDoc(state, source, { protectCaret: 17 })).toBeNull();
    const done = typed('/deep-interactive x');
    const tr = normalizeComposerDoc(done, source, { protectCaret: 19 });
    expect(chips(tr!.doc)).toEqual(['skill:深度交互']);
    expect(plainOfDoc(tr!.doc)).toBe('/deep-interactive x');
  });

  it('keeps the caret where it was in the string', () => {
    const state = typed('/deep-interactive x');
    const moved = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    const after = moved.apply(normalizeComposerDoc(moved, source)!);
    expect(offsetOfPos(after.doc, after.selection.from)).toBe(19);
  });

  it('gives text typed against a skill chip the space a handle needs', () => {
    const state = stateOf('/deep-interactive');
    const glued = state.apply(state.tr.insert(2, composerSchema.text('做')));
    expect(plainOfDoc(glued.doc)).toBe('/deep-interactive做');
    const tr = normalizeComposerDoc(glued, source)!;
    expect(plainOfDoc(tr.doc)).toBe('/deep-interactive 做');
    expect(chips(tr.doc)).toEqual(['skill:深度交互']);
  });

  it('keeps a chip the source no longer knows until it is told to unbind', () => {
    const state = stateOf('see @Fractions now');
    const without: ComposerChipSource = { ...source, mentions: new Map() };
    expect(normalizeComposerDoc(state, without)).toBeNull();
    const tr = normalizeComposerDoc(state, without, { unbind: true })!;
    expect(chips(tr.doc)).toEqual([]);
    expect(plainOfDoc(tr.doc)).toBe('see @Fractions now');
  });

  it('changes nothing for a document already in line', () => {
    expect(
      normalizeComposerDoc(stateOf('/deep-interactive see @Fractions now'), source),
    ).toBeNull();
  });
});

describe('an edit from outside', () => {
  it('replaces only what differs, as one undoable step', () => {
    const state = stateOf('compare ');
    const tr = replaceComposerDoc(state, 'compare @Fractions ', source)!;
    expect(tr.steps).toHaveLength(1);
    const next = state.apply(tr);
    expect(chips(next.doc)).toEqual(['course:Fractions, the whole unit']);
    let back = next;
    undo(next, (undoTr) => {
      back = next.apply(undoTr);
    });
    expect(plainOfDoc(back.doc)).toBe('compare ');
    let again = back;
    redo(back, (redoTr) => {
      again = back.apply(redoTr);
    });
    expect(chips(again.doc)).toEqual(['course:Fractions, the whole unit']);
  });

  it('does nothing when the document already says it', () => {
    expect(
      replaceComposerDoc(stateOf('a /deep-interactive b'), 'a /deep-interactive b', source),
    ).toBeNull();
  });
});
