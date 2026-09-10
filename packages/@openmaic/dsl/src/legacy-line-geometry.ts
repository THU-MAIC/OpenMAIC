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
 *     enclosing objects are copied along the touched path,
 *   - **returns the input by identity** when nothing needs stripping, so
 *     callers can detect a no-op cheaply,
 *   - **shares** every untouched subtree by reference,
 *   - **idempotent**: stripping an already-clean document is a no-op.
 *
 * Every line-element surface of every migratable envelope is walked (see
 * `version.ts`: the migratable unit is deliberately envelope-agnostic):
 *   - a **Stage aggregate** (`{ stage, scenes }`): each scene's canvas
 *     (`scenes[*].content.canvas.elements`) and interactive whiteboard slides
 *     (`scenes[*].whiteboards[*].elements`, which hang their `elements`
 *     directly off the slide), plus the stage-level explainer boards
 *     (`stage.whiteboard[*].elements`),
 *   - a **single Scene row** (its `content.canvas` and `whiteboards`),
 *   - a **single Stage row** (its `whiteboard`).
 * Quiz / widget / PBL and other scene kinds pass through untouched: their
 * `content.type` is not `'slide'`, so even a canvas-shaped app extension on
 * them is out of scope (an absent `content.type` stays eligible — the
 * dirty-line epoch predates schema enforcement). Anything else that is not
 * shaped as expected (a missing level, a non-array where an array is
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
 * elements on every slide surface of a Stage aggregate, a single Scene row, or
 * a single Stage row (see the module docstring for the exact paths). Pure:
 * returns the input by identity when nothing needs stripping; fresh objects
 * along the touched path otherwise.
 */
export function stripLegacyLineGeometry(doc: unknown): unknown {
  if (!isObject(doc)) return doc;

  // Single Scene row: slide surfaces hang off `content.canvas` / `whiteboards`.
  const asScene = stripSceneFields(doc);
  if (asScene !== undefined) return asScene;

  // Single Stage row: explainer boards hang off `whiteboard`.
  const asStage = stripStageFields(doc);
  if (asStage !== undefined) return asStage;

  // Stage aggregate: the scenes array, plus the embedded stage row whose
  // explainer boards can carry the same stray fields.
  if (!Array.isArray(doc.scenes)) return doc;

  let nextScenes: unknown[] | undefined;
  (doc.scenes as unknown[]).forEach((scene, sceneIndex) => {
    if (!isObject(scene)) return;
    const nextScene = stripSceneFields(scene);
    if (nextScene === undefined) return;
    (nextScenes ??= [...(doc.scenes as unknown[])])[sceneIndex] = nextScene;
  });

  const nextStage = isObject(doc.stage) ? stripStageFields(doc.stage) : undefined;
  if (nextScenes === undefined && nextStage === undefined) return doc;
  return {
    ...doc,
    ...(nextScenes !== undefined ? { scenes: nextScenes } : {}),
    ...(nextStage !== undefined ? { stage: nextStage } : {}),
  };
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

/**
 * Strip a list of slide-like objects (scene `whiteboards`, stage `whiteboard`):
 * each entry hangs its `elements` directly off the object. Returns a fresh
 * array when anything was stripped, `undefined` when the list is clean.
 */
function stripSlideList(slides: unknown[]): unknown[] | undefined {
  let nextSlides: unknown[] | undefined;
  slides.forEach((slide, slideIndex) => {
    if (!isObject(slide) || !Array.isArray(slide.elements)) return;
    const nextElements = stripElementList(slide.elements);
    if (nextElements === undefined) return;
    (nextSlides ??= [...slides])[slideIndex] = { ...slide, elements: nextElements };
  });
  return nextSlides;
}

/**
 * Strip the slide surfaces of one scene-shaped row (main canvas under
 * `content.canvas`, interactive whiteboard slides under `whiteboards`).
 * Returns a fresh row when anything was stripped, `undefined` when clean.
 */
function stripSceneFields(scene: Raw): Raw | undefined {
  let nextScene: Raw | undefined;

  const content = scene.content;
  if (isObject(content)) {
    // Gate on the slide discriminant so a non-slide scene kind carrying a
    // canvas-shaped app extension is never touched. Legacy writes were not
    // schema-checked either, so an absent discriminant stays eligible: the
    // dirty-line epoch predates schema enforcement, and quiz / widget / PBL
    // content always carries its own type.
    const slideShaped = content.type === 'slide' || content.type === undefined;
    const canvas = slideShaped ? content.canvas : undefined;
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

  if (Array.isArray(scene.whiteboards)) {
    const nextWhiteboards = stripSlideList(scene.whiteboards as unknown[]);
    if (nextWhiteboards !== undefined) {
      nextScene = { ...(nextScene ?? scene), whiteboards: nextWhiteboards };
    }
  }

  return nextScene;
}

/**
 * Strip the explainer-board surface of one stage-shaped row (`whiteboard`).
 * Returns a fresh row when anything was stripped, `undefined` when clean.
 */
function stripStageFields(stage: Raw): Raw | undefined {
  if (!Array.isArray(stage.whiteboard)) return undefined;
  const nextWhiteboard = stripSlideList(stage.whiteboard as unknown[]);
  return nextWhiteboard === undefined ? undefined : { ...stage, whiteboard: nextWhiteboard };
}
