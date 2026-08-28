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
 * Both slide surfaces are walked: the scene canvas
 * (`scenes[*].content.canvas.elements`) and interactive whiteboard slides
 * (`scenes[*].whiteboards[*].elements`, which hang their `elements` directly
 * off the slide) — both were written by the same unchecked runtimes. Quiz /
 * widget / PBL and other scene kinds pass through untouched. Anything that is
 * not shaped as expected (a missing level, a non-array where an array is
 * expected, a non-object element) passes through untouched too: this is a
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
 * elements anywhere under a document's slide surfaces:
 * `scenes[*].content.canvas.elements` and `scenes[*].whiteboards[*].elements`.
 * Pure: returns the input by identity when nothing needs stripping; fresh
 * objects along the touched path otherwise. See the module docstring for why
 * the strip is lossless and what passes through.
 */
export function stripLegacyLineGeometry(doc: unknown): unknown {
  if (!isObject(doc) || !Array.isArray(doc.scenes)) return doc;

  let nextScenes: unknown[] | undefined;
  doc.scenes.forEach((scene, sceneIndex) => {
    if (!isObject(scene)) return;

    let nextScene: Raw | undefined;

    // The scene's main slide canvas.
    const content = scene.content;
    if (isObject(content)) {
      const canvas = content.canvas;
      if (isObject(canvas) && Array.isArray(canvas.elements)) {
        const nextElements = stripElementList(canvas.elements);
        if (nextElements !== undefined) {
          nextScene = {
            ...scene,
            content: { ...content, canvas: { ...canvas, elements: nextElements } },
          };
        }
      }
    }

    // Interactive whiteboard slides: same elements union, hanging directly off
    // the slide instead of under `content.canvas`.
    if (Array.isArray(scene.whiteboards)) {
      let nextWhiteboards: unknown[] | undefined;
      (scene.whiteboards as unknown[]).forEach((slide, slideIndex) => {
        if (!isObject(slide) || !Array.isArray(slide.elements)) return;
        const nextElements = stripElementList(slide.elements);
        if (nextElements === undefined) return;
        (nextWhiteboards ??= [...(scene.whiteboards as unknown[])])[slideIndex] = {
          ...slide,
          elements: nextElements,
        };
      });
      if (nextWhiteboards !== undefined) {
        nextScene = { ...(nextScene ?? scene), whiteboards: nextWhiteboards };
      }
    }

    if (nextScene !== undefined) {
      (nextScenes ??= [...(doc.scenes as unknown[])])[sceneIndex] = nextScene;
    }
  });
  if (nextScenes === undefined) return doc;
  return { ...doc, scenes: nextScenes };
}

/**
 * Strip one flat elements array. Returns a fresh array when anything was
 * stripped, `undefined` when the list is already clean (so callers can skip
 * copying the enclosing objects).
 */
function stripElementList(elements: unknown[]): unknown[] | undefined {
  let nextElements: unknown[] | undefined;
  elements.forEach((el, elementIndex) => {
    if (!ownsAnyField(el, STRIPPED_LINE_FIELDS) || el.type !== 'line') return;
    const stripped = { ...el };
    for (const field of STRIPPED_LINE_FIELDS) delete stripped[field];
    (nextElements ??= [...elements])[elementIndex] = stripped;
  });
  return nextElements;
}
