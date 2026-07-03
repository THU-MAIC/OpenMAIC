/**
 * Pure, dependency-free element normalization for the slide DSL contract.
 *
 * The companion to {@link import('./validate.js')}: where the validators *report*
 * on a document, `normalize` *repairs* one. It fills the required fields a
 * producer may have left off, derives geometry-dependent fields, and fails loud
 * on values it cannot interpret — returning a fully-defaulted document that then
 * satisfies `validateScene` / `validateStage`.
 *
 * This is the contract's home for the "fix up the output" pass every producer
 * used to carry imperatively (the generator's element defaults, the importer's
 * theme fill, …). Owning it here keeps the defaults consistent across producers,
 * ships them as part of the published contract (the same static values are
 * emitted onto the JSON Schema as `default` annotations — see `slides.ts`), and
 * makes them visible to non-TS consumers.
 *
 * Boundary (mirrors #787's split): `normalize` owns **structural** defaults —
 * the ones that are the same for every producer:
 *   - static defaults for required fields (font / color / style / fill / …),
 *   - geometry-derived defaults (a line's `start` / `end`, a shape's `viewBox` /
 *     `path`),
 *   - fail-loud coercion (a present-but-malformed field is a producer bug, not
 *     something to silently reset).
 * It does NOT own media-specific reconciliation — e.g. fitting an image box to a
 * resolved asset's real dimensions. That depends on data outside the document
 * and stays a producer concern.
 *
 * Semantics (for the required *content* fields normalize owns):
 *   - **missing** required field  -> filled with the canonical default,
 *   - **present but wrong-typed**  -> throws (fail loud),
 *   - **present and well-formed**  -> passed through untouched.
 * Pure and non-mutating: inputs are never modified; every result is a fresh
 * object. Idempotent: `normalize(normalize(x))` deep-equals `normalize(x)`.
 *
 * Scope: normalize owns element **content** — the per-variant required fields
 * (font / colour / fill / style / points) and geometry it can derive (a line's
 * `start` / `end`, a shape's `viewBox` / `path`). It does NOT fill or check the
 * base identity / geometry every element shares (`id`, `left`, `top`, `width`,
 * `height`, `rotate`): those are producer-supplied (the `id`, notably, is often
 * assigned downstream of this pass), so they carry no content default. Run the
 * `validate*` functions / the JSON Schema for full structural validation of
 * those — normalize and validate are complementary, not redundant.
 *
 * No runtime dependencies.
 */
import type {
  PPTElement,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  LinePoint,
  LineStyleType,
} from './slides.js';
import type { Scene, SceneType, Stage } from './stage.js';
import { isSlideContent } from './stage.js';

/**
 * The canonical static defaults for required element fields, and the single
 * source of truth for them. The same values are mirrored onto the generated
 * JSON Schema via `@default` JSDoc on the type fields in `slides.ts`; a test
 * (`test/normalize.test.ts`) pins the two together so they cannot drift.
 *
 * Only *static* defaults live here. Geometry-derived defaults (`line.start` /
 * `end`, `shape.viewBox` / `path`) are computed from the element's box at
 * normalize time and have no fixed value to annotate.
 */
export const ELEMENT_DEFAULTS = {
  text: {
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
    content: '',
  },
  image: {
    fixedRatio: true,
  },
  shape: {
    fill: '#5b9bd5',
    fixedRatio: false,
  },
  shapeText: {
    content: '',
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
    align: 'middle',
  },
  line: {
    style: 'solid',
    color: '#333333',
    points: ['', ''],
  },
} as const;

const LINE_STYLES: readonly LineStyleType[] = ['solid', 'dashed', 'dotted'];
const LINE_POINT_MARKERS: readonly LinePoint[] = ['', 'arrow', 'dot'];

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumberPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

function isLinePoints(v: unknown): v is [LinePoint, LinePoint] {
  const markers = LINE_POINT_MARKERS as readonly unknown[];
  return Array.isArray(v) && v.length === 2 && markers.includes(v[0]) && markers.includes(v[1]);
}

function fail(el: Raw, field: string, expected: string, value: unknown = el[field]): never {
  throw new Error(
    `@openmaic/dsl: cannot normalize ${String(el.type)} element ${JSON.stringify(el.id)}: ` +
      `\`${field}\` must be ${expected}, got ${JSON.stringify(value)}`,
  );
}

/**
 * Fill a required string field. Treats `undefined` **and empty string** as
 * absent — an empty font name / colour / fill is effectively unset — and
 * defaults them. A present non-string is a producer bug: fail loud.
 */
function str(el: Raw, field: string, def: string): string {
  const v = el[field];
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string') fail(el, field, 'a string');
  return v;
}

/** Fill a required boolean field. Only `undefined` is absent — `false` stays `false`. */
function bool(el: Raw, field: string, def: boolean): boolean {
  const v = el[field];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') fail(el, field, 'a boolean');
  return v;
}

/** Read a numeric box field for geometry derivation. Missing -> 0; wrong-typed -> fail. */
function geom(el: Raw, field: string): number {
  const v = el[field];
  if (v === undefined) return 0;
  if (typeof v !== 'number') fail(el, field, 'a number');
  return v;
}

/** Fill a required `[x, y]` pair, deriving it from the box when absent. */
function pair(el: Raw, field: string, derive: () => [number, number]): [number, number] {
  const v = el[field];
  if (v === undefined) return derive();
  if (!isNumberPair(v)) fail(el, field, 'an [x, y] number pair');
  return v;
}

/**
 * Fill a required string field whose default is *derived* from the element (not
 * a fixed value) — e.g. a shape's `path`. Absent (or empty) derives; present
 * non-string fails loud.
 */
function strOrDerive(el: Raw, field: string, derive: () => string): string {
  const v = el[field];
  if (v === undefined || v === '') return derive();
  if (typeof v !== 'string') fail(el, field, 'a string');
  return v;
}

function rectPath(width: number, height: number): string {
  return `M0 0 L${width} 0 L${width} ${height} L0 ${height} Z`;
}

function normalizeText(el: Raw): PPTTextElement {
  return {
    ...el,
    defaultFontName: str(el, 'defaultFontName', ELEMENT_DEFAULTS.text.defaultFontName),
    defaultColor: str(el, 'defaultColor', ELEMENT_DEFAULTS.text.defaultColor),
    content: str(el, 'content', ELEMENT_DEFAULTS.text.content),
  } as PPTTextElement;
}

function normalizeImage(el: Raw): PPTImageElement {
  return {
    ...el,
    fixedRatio: bool(el, 'fixedRatio', ELEMENT_DEFAULTS.image.fixedRatio),
  } as PPTImageElement;
}

function normalizeShape(el: Raw): PPTShapeElement {
  return {
    ...el,
    viewBox: pair(el, 'viewBox', () => [geom(el, 'width'), geom(el, 'height')]),
    path: strOrDerive(el, 'path', () => rectPath(geom(el, 'width'), geom(el, 'height'))),
    fill: str(el, 'fill', ELEMENT_DEFAULTS.shape.fill),
    fixedRatio: bool(el, 'fixedRatio', ELEMENT_DEFAULTS.shape.fixedRatio),
    ...(el.text !== undefined ? { text: normalizeShapeText(el) } : {}),
  } as PPTShapeElement;
}

const SHAPE_TEXT_ALIGNS: readonly string[] = ['top', 'middle', 'bottom'];

/**
 * Normalize a shape's nested {@link ShapeText} overlay: its required fields are
 * part of the contract too (consumers read `text.content` unguarded, e.g. the
 * PPTX exporter), so a present `text` gets the same repair semantics as the
 * element's own fields. An absent `text` stays absent — the overlay itself is
 * optional; only its *shape* is required once present.
 */
function normalizeShapeText(el: Raw): PPTShapeElement['text'] {
  const t = el.text;
  if (!isObject(t)) fail(el, 'text', 'an object (ShapeText)');
  const textStr = (field: string, def: string): string => {
    const v = t[field];
    if (v === undefined || v === '') return def;
    if (typeof v !== 'string') fail(el, `text.${field}`, 'a string', v);
    return v;
  };
  const align = t.align;
  if (align !== undefined && !SHAPE_TEXT_ALIGNS.includes(align as string))
    fail(el, 'text.align', "one of 'top' | 'middle' | 'bottom'", align);
  return {
    ...t,
    content: textStr('content', ELEMENT_DEFAULTS.shapeText.content),
    defaultFontName: textStr('defaultFontName', ELEMENT_DEFAULTS.shapeText.defaultFontName),
    defaultColor: textStr('defaultColor', ELEMENT_DEFAULTS.shapeText.defaultColor),
    align: align === undefined ? ELEMENT_DEFAULTS.shapeText.align : align,
  } as PPTShapeElement['text'];
}

function normalizeLine(el: Raw): PPTLineElement {
  return {
    ...el,
    // `start` / `end` are **local** to the element's (left, top) origin: the
    // renderer positions the line container at (left, top) and draws the path
    // straight from `start` to `end` (see getLineElementPath / getElementRange,
    // which measure a line as `left + max(start[x], end[x])`). A box-derived
    // default is therefore a segment spanning the box from the local origin —
    // NOT the absolute (left, top) coordinates (that would offset the line by
    // its slide position twice).
    start: pair(el, 'start', () => [0, 0]),
    end: pair(el, 'end', () => [geom(el, 'width'), geom(el, 'height')]),
    style: normalizeLineStyle(el),
    color: str(el, 'color', ELEMENT_DEFAULTS.line.color),
    points: normalizeLinePoints(el),
  } as PPTLineElement;
}

function normalizeLineStyle(el: Raw): LineStyleType {
  const v = el.style;
  if (v === undefined || v === '') return ELEMENT_DEFAULTS.line.style;
  if (typeof v !== 'string' || !(LINE_STYLES as readonly string[]).includes(v))
    fail(el, 'style', "one of 'solid' | 'dashed' | 'dotted'");
  return v as LineStyleType;
}

function normalizeLinePoints(el: Raw): [LinePoint, LinePoint] {
  const v = el.points;
  if (v === undefined) return [...ELEMENT_DEFAULTS.line.points] as [LinePoint, LinePoint];
  if (!isLinePoints(v))
    fail(el, 'points', 'a [start, end] pair of markers (each "" | "arrow" | "dot")');
  return v;
}

/**
 * Normalize a single element: fill its required content defaults, derive
 * geometry, and fail loud on malformed content. Returns a fresh, content-
 * defaulted element; the input is never mutated. Base identity / geometry
 * (`id`, `left/top/width/height/rotate`) is out of scope (see the module note).
 * Element kinds the contract owns no defaults for yet (chart / table / latex /
 * video / audio / code) pass through unchanged.
 *
 * @throws if `el` is not an object, its `type` is not a known element type, or a
 * present required content field has the wrong shape.
 */
export function normalizeElement(el: unknown): PPTElement {
  if (!isObject(el))
    throw new Error(
      `@openmaic/dsl: cannot normalize element: expected an object, got ${JSON.stringify(el)}`,
    );
  switch (el.type) {
    case 'text':
      return normalizeText(el);
    case 'image':
      return normalizeImage(el);
    case 'shape':
      return normalizeShape(el);
    case 'line':
      return normalizeLine(el);
    case 'chart':
    case 'table':
    case 'latex':
    case 'video':
    case 'audio':
    case 'code':
      return el as unknown as PPTElement;
    default:
      throw new Error(
        `@openmaic/dsl: cannot normalize element ${JSON.stringify(el.id)}: ` +
          `unknown element type ${JSON.stringify(el.type)}`,
      );
  }
}

/**
 * Normalize every element on a slide-like canvas (a {@link Slide} or a
 * whiteboard — anything carrying an `elements` array). Pure; returns a fresh
 * object with normalized elements.
 */
export function normalizeSlide<T extends { elements: PPTElement[] }>(slide: T): T {
  // Spread + override is a structurally-identical `T`; TS can't prove that for a
  // generic, so the single localized cast stands in for the invariant.
  return { ...slide, elements: slide.elements.map(normalizeElement) } as T;
}

/**
 * Normalize a {@link Scene}: fills element defaults on a slide scene's canvas and
 * on any attached whiteboards. Quiz — and app-widened (interactive / pbl) —
 * content carries no slide elements and passes through untouched. Generic over
 * `TAction` / `TContent` so app-widened scenes (`Scene<AppAction, AppContent>`)
 * can call it too. Pure; returns a fresh Scene.
 */
export function normalizeScene<TAction, TContent extends { type: SceneType }>(
  scene: Scene<TAction, TContent>,
): Scene<TAction, TContent> {
  const whiteboards = scene.whiteboards?.map(normalizeSlide);
  let next: Scene<TAction, TContent> = whiteboards ? { ...scene, whiteboards } : { ...scene };
  if (isSlideContent(scene.content)) {
    // Spread + override yields a structurally-identical scene; TS can't prove
    // that through the generic content parameter, so the localized cast stands
    // in for the invariant (the type <-> content binding is preserved — we only
    // replace the slide canvas with its normalized copy).
    next = {
      ...next,
      content: { ...scene.content, canvas: normalizeSlide(scene.content.canvas) },
    } as Scene<TAction, TContent>;
  }
  return next;
}

/**
 * Normalize a {@link Stage}: fills element defaults on every whiteboard the
 * stage carries. Pure; returns a fresh Stage (the input when there is nothing to
 * normalize).
 */
export function normalizeStage(stage: Stage): Stage {
  if (!stage.whiteboard) return { ...stage };
  return { ...stage, whiteboard: stage.whiteboard.map(normalizeSlide) };
}
