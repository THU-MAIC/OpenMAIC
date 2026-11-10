/**
 * The composer's document, and the one rule that keeps it the same thing as its
 * plain string.
 *
 * The composers still hold, send and reason about a plain string: `/deep-interactive`
 * and `@name` are text in it. On screen those runs are inline atoms (chips), one
 * node each. So this module is a pair of mappings -- document to string, offset
 * to position -- plus the rule for which runs of text are chips, and it is pure
 * (no view, no React) so that all of it is testable without a browser.
 *
 * A LINE BREAK IS A PARAGRAPH BOUNDARY: `\n` is one character of the string and
 * two tokens of the document, which is why offsets and positions need mapping
 * rather than arithmetic. A chip is one token of the document and its whole text
 * in the string; an offset inside a chip's text lands after the chip.
 */
import { DOMSerializer, Fragment, Schema, Slice, type Node } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

import { composerChipIconSpec, type ComposerChipIcon } from './composer-chip-icons';
import { segmentMentions, type InlineMention } from './composer-mentions';
import { segmentSkillHandles } from './composer-skills';

export type ComposerChipKind = 'skill' | InlineMention['kind'];

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    chip: {
      group: 'inline',
      inline: true,
      atom: true,
      // Arrow keys step over it and a click puts the caret beside it: a chip is
      // a word of the sentence, not an object to select.
      selectable: false,
      attrs: {
        kind: {},
        /** What the string holds for it: `/handle` or `@label`. */
        text: {},
        /** What it shows. */
        label: {},
        icon: {},
        /** A mention's reference, carried so an undo can bring it back. */
        id: { default: null },
        name: { default: null },
      },
      toDOM: (node) => [
        'span',
        { class: 'composer-chip', 'data-chip': node.attrs.kind, title: node.attrs.label },
        composerChipIconSpec(node.attrs.icon as ComposerChipIcon),
        ['span', { class: 'composer-chip-label' }, node.attrs.label],
      ],
    },
  },
});

const { chip: chipType, paragraph: paragraphType } = composerSchema.nodes as Record<
  'chip' | 'paragraph',
  NonNullable<(typeof composerSchema.nodes)[string]>
>;

/** What the composer knows that makes a run of text a chip. */
export interface ComposerChipSource {
  /** Installed skills by name, with the name each is shown under. */
  readonly skills: ReadonlyMap<string, string>;
  /** The draft's mentions by label (`@` included). */
  readonly mentions: ReadonlyMap<string, InlineMention>;
  /** A mention's glyph, from its kind and name. */
  readonly mentionIcon: (mention: InlineMention) => ComposerChipIcon;
}

/** What a chip shows and stands for. */
export interface ComposerChipAttrs {
  readonly kind: ComposerChipKind;
  /** What the string holds for it: `/handle` or `@label`. */
  readonly text: string;
  readonly label: string;
  readonly icon: ComposerChipIcon;
  readonly id: string | null;
  readonly name: string | null;
}

/** The chip a run of text is, or null when it does not resolve. */
export function composerChipAttrs(
  text: string,
  source: ComposerChipSource,
): ComposerChipAttrs | null {
  const mention = source.mentions.get(text);
  if (mention) {
    return {
      kind: mention.kind,
      text,
      label: mention.name,
      icon: source.mentionIcon(mention),
      id: mention.id,
      name: mention.name,
    };
  }
  const shown = text.startsWith('/') ? source.skills.get(text.slice(1)) : undefined;
  return shown === undefined
    ? null
    : { kind: 'skill', text, label: shown, icon: 'sparkles', id: null, name: null };
}

function chipFor(text: string, source: ComposerChipSource): Node | null {
  const attrs = composerChipAttrs(text, source);
  return attrs ? chipType.create(attrs) : null;
}

function plainOfParagraph(paragraph: Node): string {
  let text = '';
  paragraph.forEach((child) => {
    text += child.isText ? child.text! : (child.attrs.text as string);
  });
  return text;
}

/** The composer's string for a document. */
export function plainOfDoc(doc: Node): string {
  const lines: string[] = [];
  doc.forEach((paragraph) => lines.push(plainOfParagraph(paragraph)));
  return lines.join('\n');
}

/** What the clipboard's text holds for a selection: the plain string, chips as their text. */
export function plainOfSlice(slice: Slice): string {
  const lines: string[] = [];
  let inlineRun = '';
  let sawBlock = false;
  slice.content.forEach((node) => {
    if (node.isTextblock) {
      sawBlock = true;
      lines.push(plainOfParagraph(node));
    } else {
      inlineRun += node.isText ? node.text! : (node.attrs.text as string);
    }
  });
  return sawBlock ? lines.join('\n') : inlineRun;
}

/** The clipboard's HTML for a selection: no chips in it, so it pastes as the text does. */
export const composerClipboardSerializer = new DOMSerializer(
  {
    paragraph: () => ['p', 0],
    text: (node) => node.text!,
    chip: (node) => node.attrs.text as string,
  },
  {},
);

/** A position in the document, as an offset into its string. */
export function offsetOfPos(doc: Node, pos: number): number {
  let offset = 0;
  let cursor = 0;
  let first = true;
  doc.forEach((paragraph) => {
    if (cursor >= pos) return;
    if (!first) offset += 1;
    first = false;
    let inner = cursor + 1;
    paragraph.forEach((child) => {
      if (inner >= pos) return;
      if (child.isText) {
        offset += Math.min(child.nodeSize, pos - inner);
      } else {
        offset += (child.attrs.text as string).length;
      }
      inner += child.nodeSize;
    });
    cursor += paragraph.nodeSize;
  });
  return offset;
}

/** An offset into the string, as a position; one inside a chip's text lands after the chip. */
export function posOfOffset(doc: Node, offset: number): number {
  let remaining = Math.max(0, offset);
  let cursor = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const paragraph = doc.child(index);
    const length = plainOfParagraph(paragraph).length;
    if (remaining <= length || index === doc.childCount - 1) {
      let inner = cursor + 1;
      for (let at = 0; at < paragraph.childCount && remaining > 0; at += 1) {
        const child = paragraph.child(at);
        if (child.isText) {
          const step = Math.min(child.nodeSize, remaining);
          inner += step;
          remaining -= step;
        } else {
          inner += child.nodeSize;
          remaining -= (child.attrs.text as string).length;
        }
      }
      return inner;
    }
    remaining -= length + 1;
    cursor += paragraph.nodeSize;
  }
  return cursor;
}

/** One run of a line: plain text, or the text of a chip. */
interface LineRun {
  readonly text: string;
  readonly chip: boolean;
}

function runsOfLine(line: string, names: readonly string[], labels: readonly string[]): LineRun[] {
  return segmentSkillHandles(line, names).flatMap((segment): LineRun[] =>
    segment.skill
      ? [{ text: segment.text, chip: true }]
      : segmentMentions(segment.text, labels).map((run) => ({
          text: run.text,
          chip: run.mention,
        })),
  );
}

/**
 * A whole text cut into plain runs and chips: the same rule the input draws by,
 * for a surface that only shows the text. Joining every run's text gives it back.
 */
export function composerTextRuns(
  text: string,
  source: ComposerChipSource,
): readonly { readonly text: string; readonly chip: ComposerChipAttrs | null }[] {
  const names = namesOf(source);
  const labels = labelsOf(source);
  return text.split('\n').flatMap((line, index) => [
    ...(index > 0 ? [{ text: '\n', chip: null }] : []),
    ...runsOfLine(line, names, labels).map((run) => ({
      text: run.text,
      chip: run.chip ? composerChipAttrs(run.text, source) : null,
    })),
  ]);
}

function namesOf(source: ComposerChipSource): string[] {
  return [...source.skills.keys()];
}

function labelsOf(source: ComposerChipSource): string[] {
  return [...source.mentions.keys()];
}

/** A line as inline nodes. Adjacent plain runs join, as ProseMirror's own text does. */
function inlineNodes(
  runs: readonly LineRun[],
  makeChip: (text: string) => Node | null,
  keepAsText: (start: number, end: number) => boolean = () => false,
): Node[] {
  const nodes: Node[] = [];
  let pending = '';
  let at = 0;
  const flush = () => {
    if (pending) nodes.push(composerSchema.text(pending));
    pending = '';
  };
  for (const run of runs) {
    const start = at;
    at += run.text.length;
    const chip = run.chip && !keepAsText(start, at) ? makeChip(run.text) : null;
    if (chip) {
      flush();
      nodes.push(chip);
    } else {
      pending += run.text;
    }
  }
  flush();
  return nodes;
}

/** The document for a string: every run that is a chip, a chip. */
export function docFromPlain(text: string, source: ComposerChipSource): Node {
  const names = namesOf(source);
  const labels = labelsOf(source);
  const paragraphs = text.split('\n').map((line) =>
    paragraphType.create(
      null,
      inlineNodes(runsOfLine(line, names, labels), (run) => chipFor(run, source)),
    ),
  );
  return composerSchema.nodes.doc!.create(null, paragraphs);
}

/** Pasted text as a slice: plain text only, a line break a paragraph. */
export function sliceOfPlainText(text: string): Slice {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) {
    return lines[0] ? new Slice(Fragment.from(composerSchema.text(lines[0])), 0, 0) : Slice.empty;
  }
  const paragraphs = lines.map((line) =>
    paragraphType.create(null, line ? composerSchema.text(line) : undefined),
  );
  return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

/**
 * Keep a skill chip a token of its own. A handle only means anything to the model
 * as a whole whitespace-delimited token, so text typed against a skill chip gets
 * the space the string needs.
 */
function spaceSkillChips(tr: Transaction): void {
  const gaps: number[] = [];
  const needsGap = (node: Node | null | undefined, side: 'before' | 'after'): boolean => {
    if (!node) return false;
    if (!node.isText) return true;
    const edge = side === 'before' ? node.text!.at(-1) : node.text![0];
    return edge !== undefined && !/\s/.test(edge);
  };
  tr.doc.descendants((node, pos, parent, index) => {
    if (node.type !== chipType || node.attrs.kind !== 'skill' || !parent) return;
    if (needsGap(index > 0 ? parent.child(index - 1) : null, 'before')) gaps.push(pos);
    if (needsGap(index + 1 < parent.childCount ? parent.child(index + 1) : null, 'after')) {
      gaps.push(pos + node.nodeSize);
    }
  });
  for (const pos of [...new Set(gaps)].sort((a, b) => b - a)) tr.insertText(' ', pos);
}

/**
 * Bring the document in line with the rule for chips, or null when it already is.
 *
 * `protectCaret`: the offset of a caret still typing. A run it touches stays text
 * until the caret leaves, or `/deep-interactive2` could never be typed. `unbind`: a
 * chip the source no longer knows goes back to text. Without it such a chip stays,
 * because an undo can bring one back before its reference has returned.
 */
export function normalizeComposerDoc(
  state: EditorState,
  source: ComposerChipSource,
  options: { readonly protectCaret?: number | null; readonly unbind?: boolean } = {},
): Transaction | null {
  const tr = state.tr;
  spaceSkillChips(tr);
  const anchor = offsetOfPos(tr.doc, tr.selection.anchor);
  const head = offsetOfPos(tr.doc, tr.selection.head);
  let replaced = false;
  let lineStart = 0;
  const edits: { from: number; to: number; nodes: Node[] }[] = [];
  let pos = 0;
  tr.doc.forEach((paragraph) => {
    const line = plainOfParagraph(paragraph);
    const existing = new Map<number, Node>();
    let at = 0;
    paragraph.forEach((child) => {
      if (!child.isText) existing.set(at, child);
      at += child.isText ? child.nodeSize : (child.attrs.text as string).length;
    });
    const names = new Set(namesOf(source));
    const labels = new Set(labelsOf(source));
    if (!options.unbind) {
      for (const chip of existing.values()) {
        if (chip.attrs.kind === 'skill') names.add((chip.attrs.text as string).slice(1));
        else labels.add(chip.attrs.text as string);
      }
    }
    const caret =
      options.protectCaret === null || options.protectCaret === undefined
        ? null
        : options.protectCaret - lineStart;
    const nodes = inlineNodes(
      runsOfLine(line, [...names], [...labels]),
      (text) => {
        const made = chipFor(text, source);
        if (made) return made;
        for (const chip of existing.values()) if (chip.attrs.text === text) return chip;
        return null;
      },
      (start, end) => caret !== null && caret >= start && caret <= end && !existing.has(start),
    );
    if (!Fragment.fromArray(nodes).eq(paragraph.content)) {
      edits.push({ from: pos + 1, to: pos + paragraph.nodeSize - 1, nodes });
    }
    lineStart += line.length + 1;
    pos += paragraph.nodeSize;
  });
  for (const edit of edits.reverse()) {
    tr.replaceWith(edit.from, edit.to, edit.nodes);
    replaced = true;
  }
  if (replaced) {
    tr.setSelection(
      TextSelection.create(tr.doc, posOfOffset(tr.doc, anchor), posOfOffset(tr.doc, head)),
    );
  }
  return tr.docChanged ? tr : null;
}

/**
 * Make the document say `text`, touching only what differs, so that a pick from a
 * menu is one small undoable step and the rest of the draft keeps its nodes.
 */
export function replaceComposerDoc(
  state: EditorState,
  text: string,
  source: ComposerChipSource,
): Transaction | null {
  const next = docFromPlain(text, source);
  const start = state.doc.content.findDiffStart(next.content);
  if (start === null) return null;
  const ends = state.doc.content.findDiffEnd(next.content)!;
  let { a: endA, b: endB } = ends;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return state.tr.replace(start, endA, next.slice(start, endB));
}
