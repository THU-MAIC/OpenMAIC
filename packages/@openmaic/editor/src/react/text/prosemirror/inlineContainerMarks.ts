import { Fragment, Slice, type Mark, type Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

export const isInlineContainer = (node: Node): boolean =>
  node.type.name === 'inline_text_box' || node.type.name === 'pptx_tab_column';

function usesGlyphUnits(node: Node): boolean {
  return (
    Object.values(node.attrs).some(
      (value) => typeof value === 'string' && /[\d.](?:ch|ex)\b/i.test(value),
    ) || Array.from({ length: node.childCount }, (_, i) => node.child(i)).some(usesGlyphUnits)
  );
}

/** Semantic formatting belongs to editable contents, not their fixed-width wrapper.
 * Otherwise selecting text inside the wrapper cannot remove inherited marks.
 * Font family/size and sub/sup stay on wrappers: em/ex/ch dimensions and relative child
 * font sizes depend on that inherited typography context. Sub/sup also supply
 * an implicit smaller font size and position the whole box on the baseline.
 * Inner marks override outer marks of the same type, just as in the source HTML.
 */
export function normalizeInlineContainerMarks(node: Node, inherited: readonly Mark[] = []): Node {
  let marks = inherited;
  for (const mark of node.marks) marks = mark.addToSet(marks);
  const container = isInlineContainer(node);
  if (node.isLeaf) return node.mark(marks);
  const fontContext = marks.filter(
    (mark) =>
      mark.type.name === 'fontname' ||
      mark.type.name === 'fontsize' ||
      mark.type.name === 'subscript' ||
      mark.type.name === 'superscript' ||
      (['strong', 'em', 'code'].includes(mark.type.name) && usesGlyphUnits(node)),
  );
  const editableMarks = marks.filter((mark) => !fontContext.includes(mark));
  const children: Node[] = [];
  node.forEach((child) =>
    children.push(normalizeInlineContainerMarks(child, container ? editableMarks : [])),
  );
  return node.copy(Fragment.fromArray(children)).mark(container ? fontContext : marks);
}

function scriptFontScale(element: Element | null | undefined, name: string): number {
  const tag = name === 'superscript' ? 'sup' : name === 'subscript' ? 'sub' : '';
  const script = tag ? element?.closest(tag) : null;
  const win = script?.ownerDocument.defaultView;
  if (!script?.parentElement || !win) return 1;
  const parentSize = Number.parseFloat(win.getComputedStyle(script.parentElement).fontSize);
  const scriptSize = Number.parseFloat(win.getComputedStyle(script).fontSize);
  return parentSize > 0 && scriptSize > 0 ? scriptSize / parentSize : 1;
}

// Relative sizes copied out of a container must be resolved in the source
// document, not multiplied by the destination's font context on paste.
function resolveCopiedFontSize(
  marks: readonly Mark[],
  node: Node,
  pos: number,
  view?: EditorView,
): readonly Mark[] {
  const font = marks.find((mark) => mark.type.name === 'fontsize');
  if (!font || !view?.domAtPos) return marks;
  const dom = node.isText ? view.domAtPos(pos, 1).node : view.nodeDOM(pos);
  const element = dom?.nodeType === 1 ? (dom as Element) : dom?.parentElement;
  const win = element?.ownerDocument.defaultView;
  if (!element || !win) return marks;
  const computed = win.getComputedStyle(element).fontSize;
  if (!/^[\d.]+px$/.test(computed)) return marks;
  let size = Number.parseFloat(computed);
  // Script marks serialize inside the font-size mark. Remove their measured
  // size reduction here so serialization applies that reduction exactly once.
  for (const mark of marks) size /= scriptFontScale(element, mark.type.name);
  return font.type
    .create({ ...font.attrs, fontsize: `${Number(size.toFixed(4))}px` })
    .addToSet(marks);
}

// Open slice wrappers can be discarded when pasted into ordinary text. Carry
// their inherited formatting onto the selected contents before serialization.
export function preserveOpenContainerMarks(slice: Slice, view?: EditorView): Slice {
  const map = (
    node: Node,
    start: number,
    end: number,
    pos: number,
    inherited: readonly Mark[] = [],
  ): Node => {
    let marks = inherited;
    for (const mark of node.marks) marks = mark.addToSet(marks);
    const open = isInlineContainer(node) && (start > 0 || end > 0);
    const copiedMarks = () =>
      inherited.some((mark) => ['fontsize', 'superscript', 'subscript'].includes(mark.type.name))
        ? resolveCopiedFontSize(marks, node, pos, view)
        : marks;
    if (node.isLeaf) return node.mark(copiedMarks());
    const children: Node[] = [];
    node.forEach((child, _offset, index) =>
      children.push(
        map(
          child,
          index === 0 ? start - 1 : 0,
          index === node.childCount - 1 ? end - 1 : 0,
          pos + _offset + 1,
          open ? marks : [],
        ),
      ),
    );
    return node.copy(Fragment.fromArray(children)).mark(open ? [] : copiedMarks());
  };
  const children: Node[] = [];
  slice.content.forEach((node, _offset, index) =>
    children.push(
      map(
        node,
        index === 0 ? slice.openStart : 0,
        index === slice.content.childCount - 1 ? slice.openEnd : 0,
        (view?.state?.selection.from ?? slice.openStart) - slice.openStart + _offset,
      ),
    ),
  );
  return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
}

// A partial copied box is opened into the destination container. Its text
// already inherits that container's script position, so do not apply it twice.
// Closed boxes retain their own independent formatting context.
export function removeInheritedScriptDuplicates(
  slice: Slice,
  inherited: readonly Mark[],
  view?: EditorView,
): Slice {
  const scripts = inherited.filter((mark) => ['subscript', 'superscript'].includes(mark.type.name));
  if (!scripts.length) return slice;
  const destinationDOM = view?.domAtPos(view.state.selection.from).node;
  const destination =
    destinationDOM?.nodeType === 1 ? (destinationDOM as Element) : destinationDOM?.parentElement;
  const map = (node: Node, start: number, end: number): Node => {
    if (isInlineContainer(node) && start <= 0 && end <= 0) return node;
    const children: Node[] = [];
    node.forEach((child, _offset, index) =>
      children.push(
        map(child, index === 0 ? start - 1 : 0, index === node.childCount - 1 ? end - 1 : 0),
      ),
    );
    let marks = node.marks.filter((mark) => !scripts.some((script) => script.eq(mark)));
    const font = marks.find((mark) => mark.type.name === 'fontsize');
    const absolute = font && /^([\d.]+)(px|pt|pc|in|cm|mm)$/i.exec(font.attrs.fontsize);
    if (absolute) {
      const removed = scripts.filter((script) => script.isInSet(node.marks));
      const scale = removed.reduce(
        (value, script) => value * scriptFontScale(destination, script.type.name),
        1,
      );
      if (scale !== 1)
        marks = font!.type
          .create({
            ...font!.attrs,
            fontsize: `${Number((Number(absolute[1]) * scale).toFixed(4))}${absolute[2]}`,
          })
          .addToSet(marks) as Mark[];
    }
    return (node.isLeaf ? node : node.copy(Fragment.fromArray(children))).mark(marks);
  };
  const children: Node[] = [];
  slice.content.forEach((node, _offset, index) =>
    children.push(
      map(
        node,
        index === 0 ? slice.openStart : 0,
        index === slice.content.childCount - 1 ? slice.openEnd : 0,
      ),
    ),
  );
  return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
}
