/**
 * Pure, dependency-free cleanup for legacy `line` elements carrying the stray
 * `rotate` / `height` fields the slide contract omits
 * (`PPTLineElement extends Omit<PPTBaseElement, 'height' | 'rotate'>`).
 *
 * Documents written before version stamping existed were never schema-checked,
 * so a stray `rotate` (and in principle a `height`) could survive into storage
 * on a `line` element. Since 1.0.0, whole-canvas validation against the closed
 * slide schema (`additionalProperties: false`, and the `line` variant lists
 * neither field) rejects such a canvas — so one legacy line element makes every
 * edit to its scene fail. Stripping is lossless: line geometry is fully
 * determined by `left` / `top` / `width` plus `start` / `end` (the renderer
 * positions the container at `(left, top)` and draws straight from `start` to
 * `end`), and no reader or writer uses `rotate` on a line element.
 *
 * Semantics (mirroring the package's migration transforms):
 *   - **never mutates** its input; stripped elements are fresh objects and the
 *     enclosing scene / content / canvas are copied along the touched path,
 *   - **returns the input by identity** when nothing needs stripping, so
 *     callers can detect a no-op cheaply,
 *   - **shares** every untouched subtree by reference,
 *   - **idempotent**: stripping an already-clean document is a no-op.
 *
 * Only slide-shaped content (`scenes[*].content.canvas.elements`) is walked;
 * quiz / widget / PBL and other scene kinds pass through untouched. Anything
 * that is not shaped as expected (a missing level, a non-array where an array
 * is expected, a non-object element) passes through untouched too: this is a
 * targeted cleanup, not a validator — it never throws and never invents shape.
 *
 * No runtime dependencies.
 */

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The stray fields legacy runtimes could persist on a `line` element. */
const STRIPPED_LINE_FIELDS: readonly string[] = ['rotate', 'height'];

function ownsAnyField(el: unknown, fields: readonly string[]): el is Raw {
  return isObject(el) && fields.some((field) => Object.hasOwn(el, field));
}

/**
 * Strip the stray legacy `rotate` / `height` fields from `type: 'line'`
 * elements anywhere under `scenes[*].content.canvas.elements` of a
 * document-shaped value. Pure: returns the input by identity when nothing
 * needs stripping; fresh objects along the touched path otherwise. See the
 * module docstring for why the strip is lossless and what passes through.
 */
export function stripLegacyLineGeometry(doc: unknown): unknown {
  if (!isObject(doc) || !Array.isArray(doc.scenes)) return doc;

  let nextScenes: unknown[] | undefined;
  doc.scenes.forEach((scene, sceneIndex) => {
    if (!isObject(scene)) return;
    const content = scene.content;
    if (!isObject(content)) return;
    const canvas = content.canvas;
    if (!isObject(canvas) || !Array.isArray(canvas.elements)) return;

    let nextElements: unknown[] | undefined;
    canvas.elements.forEach((el, elementIndex) => {
      if (!ownsAnyField(el, STRIPPED_LINE_FIELDS) || el.type !== 'line') return;
      const stripped = { ...el };
      for (const field of STRIPPED_LINE_FIELDS) delete stripped[field];
      (nextElements ??= [...(canvas.elements as unknown[])])[elementIndex] = stripped;
    });
    if (nextElements === undefined) return;

    (nextScenes ??= [...(doc.scenes as unknown[])])[sceneIndex] = {
      ...scene,
      content: { ...content, canvas: { ...canvas, elements: nextElements } },
    };
  });
  if (nextScenes === undefined) return doc;
  return { ...doc, scenes: nextScenes };
}
