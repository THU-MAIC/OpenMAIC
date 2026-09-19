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
import type {
  PBLAssignee,
  PBLMicrotaskStatus,
  PBLMilestoneStatus,
  PBLProject,
  PBLProjectStatus,
  PBLProficiency,
  PBLRoleType,
  PBLThreadSeat,
  PBLUiPhase,
} from './pbl.js';

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

function pblFail(field: string, expected: string, value: unknown): never {
  throw new Error(
    `@openmaic/dsl: cannot normalize PBL project: \`${field}\` must be ${expected}, got ${JSON.stringify(value)}`,
  );
}

function pblEnum<T extends string>(
  source: Raw,
  field: string,
  values: readonly T[],
  fallback: T,
  path = field,
): T {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    pblFail(
      path,
      `one of ${values.map((candidate) => JSON.stringify(candidate)).join(' | ')}`,
      value,
    );
  }
  return value as T;
}

function pblRequiredEnum<T extends string>(
  source: Raw,
  field: string,
  values: readonly T[],
  path = field,
): T {
  const value = source[field];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    pblFail(
      path,
      `one of ${values.map((candidate) => JSON.stringify(candidate)).join(' | ')}`,
      value,
    );
  }
  return value as T;
}

function pblArray(source: Raw, field: string, path = field): unknown[] {
  const value = source[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) pblFail(path, 'an array', value);
  return value;
}

function pblRequiredString(source: Raw, field: string, path = field): string {
  const value = source[field];
  if (typeof value !== 'string') pblFail(path, 'a string', value);
  return value;
}

function pblRequiredNumber(source: Raw, field: string, path = field): number {
  const value = source[field];
  if (typeof value !== 'number') pblFail(path, 'a number', value);
  return value;
}

function pblStringArray(source: Raw, field: string, path = field): string[] {
  const value = source[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    pblFail(path, 'an array of strings', value);
  }
  return value;
}

function pblRequireConsistentPresence(items: Raw[], field: string, path: string): void {
  const present = items.filter((item) => item[field] !== undefined).length;
  if (present !== 0 && present !== items.length) {
    pblFail(
      path,
      `present on every item or absent from every item`,
      items.map((item) => item[field]),
    );
  }
}

const PBL_UI_PHASES: readonly PBLUiPhase[] = ['hero', 'generating', 'workspace', 'completed'];
const PBL_PROJECT_STATUSES: readonly PBLProjectStatus[] = [
  'designing',
  'review',
  'active',
  'completed',
  'archived',
];
const PBL_MILESTONE_STATUSES: readonly PBLMilestoneStatus[] = ['locked', 'active', 'completed'];
const PBL_MICROTASK_STATUSES: readonly PBLMicrotaskStatus[] = [
  'todo',
  'in_progress',
  'completed',
  'skipped',
];
const PBL_ASSIGNEES: readonly PBLAssignee[] = ['user'];
const PBL_PROFICIENCIES: readonly PBLProficiency[] = ['', 'beginner', 'intermediate', 'advanced'];
const PBL_ROLE_TYPES: readonly PBLRoleType[] = [
  'user',
  'instructor',
  'evaluator',
  'mentor',
  'collaborator',
  'simulator',
  'system',
];

function normalizePBLThread(thread: unknown, index: number): PBLThreadSeat {
  const path = `threads[${index}]`;
  if (!isObject(thread)) pblFail(path, 'an object', thread);
  if (typeof thread.agentId !== 'string') {
    pblFail(`${path}.agentId`, 'a string', thread.agentId);
  }
  return {
    ...thread,
    agentId: thread.agentId,
    messages: pblArray(thread, 'messages', `${path}.messages`),
  };
}

/**
 * Normalize a complete design-authored PBL project without interpreting app
 * runtime state. Design-authored fields must be present because normalization
 * cannot invent project content. Seeded skeleton fields may be absent and then
 * receive their canonical values; present malformed values throw.
 *
 * Milestone and microtask statuses must each be consistently absent or present
 * across the project. All-absent milestones seed first-active then locked;
 * all-absent microtasks seed `todo`. Mixed presence is rejected.
 * Pure and idempotent.
 */
export function normalizePBLProject(project: unknown): PBLProject {
  if (!isObject(project)) pblFail('project', 'an object', project);

  const title = pblRequiredString(project, 'title');
  const description = pblRequiredString(project, 'description');
  // Optional design fields: preserved when present, never invented when absent.
  const learningObjective =
    project.learningObjective === undefined
      ? undefined
      : pblRequiredString(project, 'learningObjective');
  const gains = project.gains === undefined ? undefined : pblStringArray(project, 'gains');
  const tags = pblStringArray(project, 'tags');
  const language = pblRequiredString(project, 'language');
  const createdAt = pblRequiredString(project, 'createdAt');
  const updatedAt = pblRequiredString(project, 'updatedAt');
  const proficiency = pblRequiredEnum(project, 'proficiency', PBL_PROFICIENCIES);

  const roles = project.roles;
  if (!Array.isArray(roles)) pblFail('roles', 'an array', roles);
  roles.forEach((role, roleIndex) => {
    const rolePath = `roles[${roleIndex}]`;
    if (!isObject(role)) pblFail(rolePath, 'an object', role);
    pblRequiredString(role, 'id', `${rolePath}.id`);
    pblRequiredEnum(role, 'type', PBL_ROLE_TYPES, `${rolePath}.type`);
    pblRequiredString(role, 'name', `${rolePath}.name`);
  });

  const milestones = project.milestones;
  if (!Array.isArray(milestones)) pblFail('milestones', 'an array', milestones);
  const milestoneObjects = milestones.map((milestone, milestoneIndex) => {
    if (!isObject(milestone)) pblFail(`milestones[${milestoneIndex}]`, 'an object', milestone);
    return milestone;
  });
  pblRequireConsistentPresence(milestoneObjects, 'status', 'milestones[].status');
  const microtaskObjectsByMilestone = milestoneObjects.map((milestone, milestoneIndex) => {
    const milestonePath = `milestones[${milestoneIndex}]`;
    if (!Array.isArray(milestone.microtasks)) {
      pblFail(`${milestonePath}.microtasks`, 'an array', milestone.microtasks);
    }
    return milestone.microtasks.map((microtask, microtaskIndex) => {
      const microtaskPath = `${milestonePath}.microtasks[${microtaskIndex}]`;
      if (!isObject(microtask)) pblFail(microtaskPath, 'an object', microtask);
      return microtask;
    });
  });
  pblRequireConsistentPresence(
    microtaskObjectsByMilestone.flat(),
    'status',
    'milestones[].microtasks[].status',
  );

  const normalizedMilestones = milestoneObjects.map((milestone, milestoneIndex) => {
    const milestonePath = `milestones[${milestoneIndex}]`;
    pblRequiredString(milestone, 'id', `${milestonePath}.id`);
    pblRequiredString(milestone, 'title', `${milestonePath}.title`);
    pblRequiredNumber(milestone, 'order', `${milestonePath}.order`);
    const microtaskObjects = microtaskObjectsByMilestone[milestoneIndex];
    return {
      ...milestone,
      status: pblEnum(
        milestone,
        'status',
        PBL_MILESTONE_STATUSES,
        milestoneIndex === 0 ? 'active' : 'locked',
        `${milestonePath}.status`,
      ),
      microtasks: microtaskObjects.map((microtask, microtaskIndex) => {
        const microtaskPath = `${milestonePath}.microtasks[${microtaskIndex}]`;
        pblRequiredString(microtask, 'id', `${microtaskPath}.id`);
        pblRequiredString(microtask, 'title', `${microtaskPath}.title`);
        pblStringArray(microtask, 'hints', `${microtaskPath}.hints`);
        pblRequiredNumber(microtask, 'order', `${microtaskPath}.order`);
        return {
          ...microtask,
          status: pblEnum(
            microtask,
            'status',
            PBL_MICROTASK_STATUSES,
            'todo',
            `${microtaskPath}.status`,
          ),
          assignee: pblEnum(
            microtask,
            'assignee',
            PBL_ASSIGNEES,
            'user',
            `${microtaskPath}.assignee`,
          ),
        };
      }),
    };
  });

  let threads: PBLThreadSeat[];
  if (project.threads === undefined) {
    threads = (roles ?? []).map((role, index) => {
      if (!isObject(role) || typeof role.id !== 'string') {
        pblFail(`roles[${index}].id`, 'a string', isObject(role) ? role.id : role);
      }
      return { agentId: role.id, messages: [] };
    });
  } else {
    if (!Array.isArray(project.threads)) pblFail('threads', 'an array', project.threads);
    threads = project.threads.map(normalizePBLThread);
  }

  return {
    ...project,
    title,
    description,
    ...(learningObjective === undefined ? {} : { learningObjective }),
    ...(gains === undefined ? {} : { gains }),
    tags,
    language,
    proficiency,
    roles,
    createdAt,
    updatedAt,
    uiPhase: pblEnum(project, 'uiPhase', PBL_UI_PHASES, 'hero'),
    status: pblEnum(project, 'status', PBL_PROJECT_STATUSES, 'active'),
    milestones: normalizedMilestones,
    submissions: pblArray(project, 'submissions'),
    evaluations: pblArray(project, 'evaluations'),
    threads,
    engagementEvents: pblArray(project, 'engagementEvents'),
  } as PBLProject;
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

/**
 * Fill a required string field where the empty string is a meaningful value
 * (e.g. a shape's `fill`, where `''` means "no solid fill"). Only `undefined`
 * is absent; a present non-string is a producer bug: fail loud.
 */
function strKeepEmpty(el: Raw, field: string, def: string): string {
  const v = el[field];
  if (v === undefined) return def;
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
    // `fill` keeps an explicit `''`: unlike an empty font name, the empty string
    // is a *meaningful* fill — "no solid fill" (transparent, or gradient/pattern
    // carried by the sibling fields) — and the renderer maps it to `none`.
    // Producers emit it deliberately (the importer for gradient / image-filled /
    // unfilled shapes), so only a truly absent field gets the default.
    fill: strKeepEmpty(el, 'fill', ELEMENT_DEFAULTS.shape.fill),
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
 * Element-invalidity policy for {@link normalizeSlideWith}.
 *
 * `normalizeElement` fails loud on a present-but-wrong-typed field. What that
 * should do to the *slide* is a producer decision: a build-time producer wants
 * the throw (`'throw'`, the default — what plain {@link normalizeSlide} does);
 * a producer normalizing unreliable wild-world input (an imported deck, model
 * output) prefers to degrade — drop the one element rather than fail the whole
 * document or hand the malformed payload to consumers that read it unguarded
 * (`'drop'`). `onDropped` observes each drop (log it, count it, surface it) so
 * the loss is never silent.
 */
export interface NormalizeSlideOptions {
  onInvalid?: 'throw' | 'drop';
  onDropped?: (element: unknown, error: unknown) => void;
}

/**
 * Normalize every element on a slide-like canvas (a {@link Slide} or a
 * whiteboard — anything carrying an `elements` array). Pure; returns a fresh
 * object with normalized elements. Throws on the first element that fails
 * normalization; for a degrade-per-element policy use
 * {@link normalizeSlideWith}.
 *
 * Deliberately unary so `slides.map(normalizeSlide)` stays valid — an options
 * parameter here would collide with `map`'s index argument.
 */
export function normalizeSlide<T extends { elements: PPTElement[] }>(slide: T): T {
  // Spread + override is a structurally-identical `T`; TS can't prove that for a
  // generic, so the single localized cast stands in for the invariant.
  return { ...slide, elements: slide.elements.map(normalizeElement) } as T;
}

/**
 * Build a unary {@link normalizeSlide} variant carrying an element-invalidity
 * policy. Curried (options first) precisely so the result is safe in
 * `slides.map(...)`:
 *
 * ```ts
 * const normalize = normalizeSlideWith({ onInvalid: 'drop', onDropped: log });
 * const clean = slides.map(normalize);
 * ```
 */
export function normalizeSlideWith(
  options: NormalizeSlideOptions,
): <T extends { elements: PPTElement[] }>(slide: T) => T {
  if (options.onInvalid !== 'drop') return normalizeSlide;
  return <T extends { elements: PPTElement[] }>(slide: T): T => {
    const elements: PPTElement[] = [];
    for (const el of slide.elements) {
      try {
        elements.push(normalizeElement(el));
      } catch (error) {
        options.onDropped?.(el, error);
      }
    }
    return { ...slide, elements } as T;
  };
}

/**
 * Normalize a {@link Scene}: fills element defaults on a slide scene's canvas,
 * fills a PBL scene's canonical seeded skeleton, and normalizes any attached
 * whiteboards. Quiz and interactive content pass through untouched. Generic over
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
  } else if (scene.content.type === 'pbl' && 'projectV2' in scene.content) {
    const projectV2 = scene.content.projectV2;
    if (projectV2 !== undefined) {
      next = {
        ...next,
        content: { ...scene.content, projectV2: normalizePBLProject(projectV2) },
      } as Scene<TAction, TContent>;
    }
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
