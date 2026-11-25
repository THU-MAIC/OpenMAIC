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
  insertComposerPhrase,
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

describe('inserting a dictated phrase', () => {
  it('ignores empty or whitespace-only transcriptions', () => {
    const state = stateOf('hello', 5);
    expect(insertComposerPhrase(state, '')).toBeNull();
    expect(insertComposerPhrase(state, '   \n\t ')).toBeNull();
  });

  it('inserts into an empty document and appends with a separating space', () => {
    const first = stateOf('').apply(insertComposerPhrase(stateOf(''), '  make a quiz  ')!);
    expect(plainOfDoc(first.doc)).toBe('make a quiz');
    expect(offsetOfPos(first.doc, first.selection.from)).toBe('make a quiz'.length);

    const second = first.apply(insertComposerPhrase(first, 'on fractions')!);
    expect(plainOfDoc(second.doc)).toBe('make a quiz on fractions');
    expect(offsetOfPos(second.doc, second.selection.from)).toBe('make a quiz on fractions'.length);
  });

  it('adds no separating space next to CJK text', () => {
    const zh = stateOf('帮我出一套', '帮我出一套'.length);
    const next = zh.apply(insertComposerPhrase(zh, '分数练习题')!);
    expect(plainOfDoc(next.doc)).toBe('帮我出一套分数练习题');

    const mid = stateOf('讲解。', 2);
    const next2 = mid.apply(insertComposerPhrase(mid, '分数')!);
    expect(plainOfDoc(next2.doc)).toBe('讲解分数。');

    const mixed = stateOf('quiz', 4);
    const next3 = mixed.apply(insertComposerPhrase(mixed, '分数')!);
    expect(plainOfDoc(next3.doc)).toBe('quiz分数');
  });

  it('appends at the end when asked even if the selection is still at offset 0', () => {
    const state = stateOf('review slides', 0);
    const next = state.apply(insertComposerPhrase(state, 'and add examples', { atEnd: true })!);
    expect(plainOfDoc(next.doc)).toBe('review slides and add examples');
    expect(offsetOfPos(next.doc, next.selection.from)).toBe(
      'review slides and add examples'.length,
    );
  });

  it('inserts at a mid-sentence caret with separating spaces and leaves caret after the phrase', () => {
    const beforeSpace = stateOf('hello world', 5);
    const next1 = beforeSpace.apply(insertComposerPhrase(beforeSpace, 'brave')!);
    expect(plainOfDoc(next1.doc)).toBe('hello brave world');
    expect(offsetOfPos(next1.doc, next1.selection.from)).toBe('hello brave'.length);

    const beforeWord = stateOf('hello world', 6);
    const next2 = beforeWord.apply(insertComposerPhrase(beforeWord, 'brave')!);
    expect(plainOfDoc(next2.doc)).toBe('hello brave world');
    expect(offsetOfPos(next2.doc, next2.selection.from)).toBe('hello brave'.length);
    // A second phrase dictated immediately continues cleanly without doubling spaces.
    const next3 = next2.apply(insertComposerPhrase(next2, 'new')!);
    expect(plainOfDoc(next3.doc)).toBe('hello brave new world');

    const beforePunct = stateOf('explain fractions.', 'explain fractions'.length);
    const next4 = beforePunct.apply(insertComposerPhrase(beforePunct, 'clearly')!);
    expect(plainOfDoc(next4.doc)).toBe('explain fractions clearly.');
  });

  it('preserves inline mention and skill chips around the insertion point', () => {
    const afterChipWithSpace = stateOf('@Fractions ', '@Fractions '.length);
    const next1 = afterChipWithSpace.apply(insertComposerPhrase(afterChipWithSpace, 'add a quiz')!);
    expect(plainOfDoc(next1.doc)).toBe('@Fractions add a quiz');
    expect(chips(next1.doc)).toEqual(['course:Fractions, the whole unit']);

    const againstChip = stateOf('@Fractions', '@Fractions'.length);
    const next2 = againstChip.apply(insertComposerPhrase(againstChip, 'add a quiz')!);
    expect(plainOfDoc(next2.doc)).toBe('@Fractions add a quiz');
    expect(chips(next2.doc)).toEqual(['course:Fractions, the whole unit']);

    const beforeChip = stateOf('compare @Fractions', 'compare '.length);
    const next3 = beforeChip.apply(insertComposerPhrase(beforeChip, 'closely')!);
    expect(plainOfDoc(next3.doc)).toBe('compare closely @Fractions');
    expect(chips(next3.doc)).toEqual(['course:Fractions, the whole unit']);
  });

  it('replaces a non-empty selection cleanly', () => {
    const base = stateOf('use old method');
    const selected = base.apply(
      base.tr.setSelection(
        TextSelection.create(base.doc, posOfOffset(base.doc, 4), posOfOffset(base.doc, 7)),
      ),
    );
    const next = selected.apply(insertComposerPhrase(selected, 'new')!);
    expect(plainOfDoc(next.doc)).toBe('use new method');
  });
});
