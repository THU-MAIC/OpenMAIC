/**
 * Pure intent-mapping gate for `edit_elements`.
 *
 * Takes model-proposed element updates + the trusted slide inventory and either
 * returns validated `EditIntent`s (`element.update` / `element.updateMany`) or a
 * refusal. Malformed / out-of-contract proposals never partially apply.
 *
 * No I/O, no React, no store — fixture-testable in isolation.
 */

import type { PPTElement } from '@openmaic/dsl';
import sceneSchemaJson from '@openmaic/dsl/schema/scene.schema.json';
import type { EditIntent } from '@openmaic/renderer/editing';
import tinycolor from 'tinycolor2';
import { MIN_SIZE } from '@/configs/element';

const DEFAULT_MIN_SIZE = 20;
const LINE_STROKE_MIN = 1;
const LINE_STROKE_MAX = 100;
const GROUP_TRANSLATION_TOLERANCE = 1e-6;
const MERGED_STYLE_PROPS = new Set(['outline', 'shadow', 'filters']);
/** Sanity bounds so model JSON cannot park elements at 1e15. */
const COORD_MIN = -5000;
const COORD_MAX = 20000;
const FILTER_UNITS: Record<string, string> = {
  blur: 'px',
  brightness: '%',
  contrast: '%',
  grayscale: '%',
  saturate: '%',
  'hue-rotate': 'deg',
  sepia: '%',
  invert: '%',
  opacity: '%',
};
const FILTER_RANGES: Record<string, readonly [number, number]> = {
  blur: [0, 100],
  brightness: [0, 1000],
  contrast: [0, 1000],
  grayscale: [0, 100],
  saturate: [0, 1000],
  'hue-rotate': [-36000, 36000],
  sepia: [0, 100],
  invert: [0, 100],
  opacity: [0, 100],
};
const FILTER_IDENTITY: Record<string, number> = {
  blur: 0,
  brightness: 100,
  contrast: 100,
  grayscale: 0,
  saturate: 100,
  'hue-rotate': 0,
  sepia: 0,
  invert: 0,
  opacity: 100,
};

/** Geometry + style props the AI may mutate. Content / identity are rejected. */
export const ALLOWED_EDIT_PROPS = new Set([
  // geometry
  'left',
  'top',
  'width',
  'height',
  'rotate',
  // shared chrome
  'fill',
  'opacity',
  'outline',
  'shadow',
  // text / shape text chrome (not HTML body)
  'defaultColor',
  'defaultFontName',
  'lineHeight',
  'wordSpace',
  'paragraphSpace',
  'vertical',
  'vAlign',
  // line / latex / audio color
  'color',
  // shape
  'gradient',
  // image chrome
  'filters',
  'radius',
  'flipH',
  'flipV',
  'colorMask',
  'fixedRatio',
  // chart chrome
  'themeColors',
  'textColor',
  'lineColor',
  // code chrome (not `lines` / not user-visible fileName)
  'fontSize',
  'showLineNumbers',
]);

/** Props that must never be written by this vertical. */
export const FORBIDDEN_EDIT_PROPS = new Set([
  'id',
  'type',
  'lock',
  'groupId',
  'link',
  'content',
  'text',
  'src',
  'mediaRef',
  'lines',
  'latex',
  'html',
  'data',
  'path',
  'viewBox',
  'pathFormula',
  'keypoints',
  'start',
  'end',
  'broken',
  'broken2',
  'curve',
  'cubic',
  'colWidths',
  'rowHeights',
  'cellMinHeight',
  'animations',
  'fileName',
]);

/** Text-chrome keys that live under `shape.text` for shape elements. */
export const SHAPE_TEXT_CHROME_PROPS = new Set([
  'defaultColor',
  'defaultFontName',
  'lineHeight',
  'wordSpace',
  'paragraphSpace',
]);
const TEXT_GLYPH_PROPS = new Set([...SHAPE_TEXT_CHROME_PROPS, 'vertical', 'shadow']);

export type JsonSchema = {
  $ref?: string;
  anyOf?: JsonSchema[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minimum?: number;
  maximum?: number;
};

type SchemaDocument = {
  definitions?: Record<string, JsonSchema>;
};

const sceneSchema = sceneSchemaJson as SchemaDocument;
const schemaDefinitions = sceneSchema.definitions ?? {};

const ELEMENT_SCHEMA_DEFINITION_BY_TYPE = new Map<string, string>([
  ['text', 'PPTTextElement'],
  ['image', 'PPTImageElement'],
  ['shape', 'PPTShapeElement'],
  ['line', 'PPTLineElement'],
  ['chart', 'PPTChartElement'],
  ['table', 'PPTTableElement'],
  ['latex', 'PPTLatexElement'],
  ['video', 'PPTVideoElement'],
  ['audio', 'PPTAudioElement'],
  ['code', 'PPTCodeElement'],
]);

const REQUIRED_SCHEMA_DEFINITIONS = [
  'Gradient',
  'GradientColor',
  'PPTElement',
  'PPTElementOutline',
  'PPTElementShadow',
  'ShapeText',
  ...ELEMENT_SCHEMA_DEFINITION_BY_TYPE.values(),
];

const SHAPE_TEXT_SCHEMA_ALIASES = new Map<string, string>([
  ['defaultColor', 'defaultColor'],
  ['defaultFontName', 'defaultFontName'],
  ['lineHeight', 'lineHeight'],
  ['wordSpace', 'wordSpace'],
  ['paragraphSpace', 'paragraphSpace'],
  ['vAlign', 'align'],
]);

function schemaSourceError(detail: string): Error {
  return new Error(
    `edit_elements gate schema sanity check failed: ${detail}. Rebuild @openmaic/dsl to regenerate dist/schema/scene.schema.json.`,
  );
}

function assertGateSchemaSource(definitions: Record<string, JsonSchema>): void {
  for (const name of REQUIRED_SCHEMA_DEFINITIONS) {
    if (!definitions[name]) {
      throw schemaSourceError(`missing schema definition ${JSON.stringify(name)}`);
    }
  }

  const pptElementOptions = definitions.PPTElement?.anyOf ?? [];
  const pptElementRefs = new Set(
    pptElementOptions.map((option) => (option.$ref ? decodeRefName(option.$ref) : null)),
  );
  for (const definitionName of ELEMENT_SCHEMA_DEFINITION_BY_TYPE.values()) {
    if (!pptElementRefs.has(definitionName)) {
      throw schemaSourceError(`PPTElement union missing ${JSON.stringify(definitionName)}`);
    }
  }
}

function decodeRefName(ref: string): string | null {
  const m = ref.match(/^#\/definitions\/(.+)$/);
  return m ? m[1].replace(/~1/g, '/').replace(/~0/g, '~') : null;
}

assertGateSchemaSource(schemaDefinitions);

function resolveSchema(schema: JsonSchema, seen = new Set<string>()): JsonSchema {
  if (!schema.$ref) return schema;
  const name = decodeRefName(schema.$ref);
  if (!name || seen.has(name)) return schema;
  const target = schemaDefinitions[name];
  if (!target) return schema;
  seen.add(name);
  return resolveSchema(target, seen);
}

function elementTypeFromSchema(schema: JsonSchema): string | null {
  const typeSchema = resolveSchema(schema.properties?.type ?? {});
  return typeof typeSchema.const === 'string' ? typeSchema.const : null;
}

/**
 * Lockstep with packages/@openmaic/dsl/scripts/gen-schema.mjs: the package
 * export @openmaic/dsl/schema/scene.schema.json is generated from slides.ts.
 */
function buildEditablePropSchemas(): Map<string, Map<string, JsonSchema>> {
  const out = new Map<string, Map<string, JsonSchema>>();
  const elementUnion = resolveSchema(schemaDefinitions.PPTElement ?? {});
  for (const option of elementUnion.anyOf ?? []) {
    const elementSchema = resolveSchema(option);
    const elementType = elementTypeFromSchema(elementSchema);
    if (!elementType || !elementSchema.properties) continue;
    out.set(elementType, new Map(Object.entries(elementSchema.properties)));
  }

  const shapeProps = out.get('shape');
  const shapeTextSchema = shapeProps?.get('text');
  const shapeTextProps = shapeTextSchema ? resolveSchema(shapeTextSchema).properties : undefined;
  if (shapeProps && shapeTextProps) {
    for (const [flatProp, schemaProp] of SHAPE_TEXT_SCHEMA_ALIASES) {
      const subschema = shapeTextProps[schemaProp];
      if (subschema) shapeProps.set(flatProp, subschema);
    }
  }

  return out;
}

const EDITABLE_PROP_SCHEMAS_BY_TYPE = buildEditablePropSchemas();

for (const type of ELEMENT_SCHEMA_DEFINITION_BY_TYPE.keys()) {
  if (!EDITABLE_PROP_SCHEMAS_BY_TYPE.has(type)) {
    throw schemaSourceError(`unable to map editable schemas for ${JSON.stringify(type)} elements`);
  }
}

export function getEditablePropSchema(type: string, key: string): JsonSchema | null {
  if (!ALLOWED_EDIT_PROPS.has(key) || FORBIDDEN_EDIT_PROPS.has(key)) return null;
  return EDITABLE_PROP_SCHEMAS_BY_TYPE.get(type)?.get(key) ?? null;
}

export interface ElementInventoryItem {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height?: number;
  rotate?: number;
  lock?: boolean;
  groupId?: string;
  /** Short human-readable label for the model (stripped text / name / type). */
  label: string;
  /** Style props currently on the element that the DSL owns and AI may edit. */
  style: Record<string, unknown>;
  /** True when element-level defaultColor would be hidden by inline HTML color. */
  hasInlineTextColor?: boolean;
  /** True when element-level defaultFontName would be hidden by inline HTML font-family. */
  hasInlineFontFamily?: boolean;
  /** True when element-level lineHeight would be hidden by inline HTML line-height. */
  hasInlineLineHeight?: boolean;
  /** True when element-level wordSpace would be hidden by inline HTML letter-spacing. */
  hasInlineLetterSpacing?: boolean;
  /** True when element-level paragraphSpace would be hidden by inline HTML margin-bottom. */
  hasInlineParagraphSpacing?: boolean;
  /** True when element-level vertical writing mode would be hidden by descendant CSS. */
  hasInlineWritingMode?: boolean;
  /** True when text-element shadow would be hidden by descendant text-shadow CSS. */
  hasInlineTextShadow?: boolean;
  /** Image clip shape used to decide whether radius is visually supported. */
  imageClipShape?: string;
  /** True when a line has a non-zero start/end segment. */
  lineHasVisiblePath?: boolean;
  /** True when a zero-length line can still paint an endpoint marker. */
  lineHasEndpointMarker?: boolean;
  /** True when shape pattern paint is present and fill/gradient application would remove it. */
  hasPattern?: boolean;
  /** True when a shape currently has visible label text. */
  hasShapeText?: boolean;
  /** True when inline KaTeX HTML color would override the latex container color. */
  hasInlineLatexColor?: boolean;
  /** True when imported cell-level borders make table outline cross-renderer inconsistent. */
  hasCellBorders?: boolean;
  /** Chart subtype used for renderer capability checks. */
  chartType?: string;
  /** True when chart data produces a renderer option instead of null. */
  hasRenderableChartData?: boolean;
  /** Number of leading palette colors consumed by the current chart data. */
  chartColorCount?: number;
  /** True when a text element currently has visible glyph content. */
  hasTextGlyphs?: boolean;
  /** True when text has layout-visible characters, even if their paint is transparent. */
  hasTextContent?: boolean;
  /** True when a latex element has a visible HTML or SVG rendering branch. */
  hasRenderableLatex?: boolean;
  /** Active latex renderer branch. */
  latexRenderMode?: 'html' | 'svg' | 'none';
}

const TEXT_VISIBILITY_SOURCE = Symbol('textVisibilitySource');
type TextVisibilitySource = {
  content: string;
  colorProp: 'defaultColor' | 'color';
  color?: unknown;
  opacity?: unknown;
  shadow?: { h?: unknown; v?: unknown; blur?: unknown; color?: unknown };
};
type InternalElementInventoryItem = ElementInventoryItem & {
  [TEXT_VISIBILITY_SOURCE]?: TextVisibilitySource;
};

export interface ProposedElementUpdate {
  id: string;
  props: Record<string, unknown>;
}

export type EditElementsGateResult =
  | { ok: true; intents: EditIntent[] }
  | { ok: false; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isColorString(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 64) return false;
  const value = v.trim();
  const lower = value.toLowerCase();
  const number = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
  const percentage = `${number}%`;
  const rgbNumbers = `${number}\\s*,\\s*${number}\\s*,\\s*${number}`;
  const rgbPercentages = `${percentage}\\s*,\\s*${percentage}\\s*,\\s*${percentage}`;
  const alpha = number;
  const hue = `${number}(?:deg)?`;
  const functional =
    new RegExp(`^rgb\\(\\s*(?:${rgbNumbers}|${rgbPercentages})\\s*\\)$`, 'i').test(value) ||
    new RegExp(
      `^rgba\\(\\s*(?:${rgbNumbers}|${rgbPercentages})\\s*,\\s*${alpha}\\s*\\)$`,
      'i',
    ).test(value) ||
    new RegExp(`^hsl\\(\\s*${hue}\\s*,\\s*${percentage}\\s*,\\s*${percentage}\\s*\\)$`, 'i').test(
      value,
    ) ||
    new RegExp(
      `^hsla\\(\\s*${hue}\\s*,\\s*${percentage}\\s*,\\s*${percentage}\\s*,\\s*${alpha}\\s*\\)$`,
      'i',
    ).test(value);
  const syntaxIsCssColor =
    /^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/i.test(value) ||
    functional ||
    lower === 'transparent' ||
    Object.hasOwn(tinycolor.names, lower);
  return syntaxIsCssColor && tinycolor(value).isValid();
}

function isNonEmptyString(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

const PRO_EDITOR_SUPPORTED_TYPES = new Set([
  'text',
  'image',
  'shape',
  'line',
  'chart',
  'table',
  'latex',
  'video',
]);

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isFiniteNumber(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function describeSchemaTypes(type: string | string[]): string {
  return Array.isArray(type) ? type.join('|') : type;
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$ref',
  'anyOf',
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
]);

function propPath(path: string): string {
  return path.startsWith('prop ') ? path : `prop ${path}`;
}

function unsupportedSchemaConstruct(path: string): string {
  return `${propPath(path)} uses a schema construct the gate cannot validate`;
}

function isUnsupportedSchemaConstruct(err: string | null): boolean {
  return err?.includes('uses a schema construct the gate cannot validate') ?? false;
}

function lacksSupportedSchemaKeywords(schema: JsonSchema): boolean {
  const keys = Object.keys(schema);
  return keys.length > 0 && !keys.some((key) => SUPPORTED_SCHEMA_KEYWORDS.has(key));
}

export function validateJsonSchemaSubset(
  value: unknown,
  schema: JsonSchema,
  path: string,
): string | null {
  const s = resolveSchema(schema);
  if (s.$ref || lacksSupportedSchemaKeywords(s)) return unsupportedSchemaConstruct(path);

  if ('anyOf' in s) {
    if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) {
      return unsupportedSchemaConstruct(path);
    }
    const errors = s.anyOf
      .map((option) => validateJsonSchemaSubset(value, option, path))
      .filter(Boolean);
    if (errors.length !== s.anyOf.length) return null;
    return errors.find(isUnsupportedSchemaConstruct) ?? `${path} does not match any allowed schema`;
  }

  if ('const' in s && !Object.is(value, s.const)) {
    return `${path} must be ${JSON.stringify(s.const)}`;
  }
  if (s.enum && !s.enum.some((item) => Object.is(item, value))) {
    return `${path} must be one of ${s.enum.map((item) => JSON.stringify(item)).join('|')}`;
  }

  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      return types.includes('number')
        ? `${path} must be a finite number`
        : `${path} must be ${describeSchemaTypes(s.type)}`;
    }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a finite number`;
    if (typeof s.minimum === 'number' && value < s.minimum) {
      return `${path} out of bounds (${s.minimum}..${s.maximum ?? '∞'})`;
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      return `${path} out of bounds (${s.minimum ?? '-∞'}..${s.maximum})`;
    }
  }

  if (s.properties) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path} must be object`;
    }
    const obj = value as Record<string, unknown>;
    for (const required of s.required ?? []) {
      if (!(required in obj)) return `${path}.${required} is required`;
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!s.properties[key]) return `${path}.${key} is out of contract`;
      }
    }
    for (const [key, nested] of Object.entries(s.properties)) {
      if (key in obj) {
        const err = validateJsonSchemaSubset(obj[key], nested, `${path}.${key}`);
        if (err) return err;
      }
    }
  }

  if (s.items) {
    if (!Array.isArray(value)) return `${path} must be array`;
    if (Array.isArray(s.items)) {
      for (let i = 0; i < value.length; i++) {
        const itemSchema = s.items[Math.min(i, s.items.length - 1)];
        if (!itemSchema) continue;
        const err = validateJsonSchemaSubset(value[i], itemSchema, `${path}[${i}]`);
        if (err) return err;
      }
    } else {
      for (let i = 0; i < value.length; i++) {
        const err = validateJsonSchemaSubset(value[i], s.items, `${path}[${i}]`);
        if (err) return err;
      }
    }
  }

  return null;
}

/** Signed angle in (-180, 180], matching the rotate gesture core. */
export function normalizeRotate(degrees: number): number {
  let r = degrees % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

function minSizeFor(type: string): number {
  return MIN_SIZE[type] ?? DEFAULT_MIN_SIZE;
}

function clampCoord(n: number, label: string): number {
  if (n < COORD_MIN || n > COORD_MAX) {
    throw new Error(`${label} out of bounds (${COORD_MIN}..${COORD_MAX})`);
  }
  return n;
}

const COLOR_STRING_PROPS = new Set([
  'fill',
  'defaultColor',
  'color',
  'textColor',
  'lineColor',
  'colorMask',
]);

/**
 * Structural, enum, and ownership mismatches refuse so the model learns the
 * contract; numeric overshoot on a valid prop clamps later, matching gestures.
 */
function validatePolicyOverlay(key: string, value: unknown): string | null {
  if (COLOR_STRING_PROPS.has(key)) {
    return isColorString(value) ? null : `${key} must be a color string`;
  }

  switch (key) {
    case 'defaultFontName':
      return isNonEmptyString(value, 80) ? null : `${key} must be a non-empty string`;
    case 'opacity':
      return isFiniteNumber(value) ? null : 'opacity must be a finite number';
    case 'lineHeight':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 1 || value > 3) return `${key} out of bounds (1..3)`;
      return null;
    case 'wordSpace':
    case 'paragraphSpace':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 0 || value > 100) return `${key} out of bounds (0..100)`;
      return null;
    case 'radius':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 0 || value > 500) return `${key} out of bounds (0..500)`;
      return null;
    case 'fontSize':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 8 || value > 200) return `${key} out of bounds (8..200)`;
      return null;
    case 'outline': {
      const o = value as Record<string, unknown>;
      if (Object.keys(o).length === 0) return 'outline must contain at least one property';
      if ('width' in o && (!isFiniteNumber(o.width) || o.width < 0 || o.width > LINE_STROKE_MAX)) {
        return 'outline.width must be a finite number in range';
      }
      if ('color' in o && !isColorString(o.color)) return 'outline.color must be a color string';
      return null;
    }
    case 'shadow': {
      const o = value as Record<string, unknown>;
      if (!isColorString(o.color)) return 'shadow.color must be a color string';
      if (!isFiniteNumber(o.blur) || o.blur < 0) {
        return 'shadow.blur must be a non-negative finite number';
      }
      return null;
    }
    case 'gradient': {
      const o = value as { colors?: unknown[] };
      if (!Array.isArray(o.colors) || o.colors.length === 0 || o.colors.length > 10) {
        return 'gradient.colors must contain 1..10 stops';
      }
      for (let i = 0; i < o.colors.length; i++) {
        const stop = o.colors[i] as Record<string, unknown>;
        if (!isFiniteNumber(stop.pos) || stop.pos < 0 || stop.pos > 100) {
          return `gradient.colors[${i}].pos must be a number in [0,100]`;
        }
        if (!isColorString(stop.color)) {
          return `gradient.colors[${i}].color must be a color string`;
        }
      }
      return null;
    }
    case 'filters': {
      if (Object.keys(value as Record<string, unknown>).length === 0) {
        return 'filters must contain at least one property';
      }
      for (const [filterKey, filterValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof filterValue !== 'string') return `filters.${filterKey} must be a string`;
        if (filterValue.length > 40) return `filters.${filterKey} must be at most 40 chars`;
        const unit = FILTER_UNITS[filterKey];
        const match = filterValue.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%|deg)?$/);
        if (!match || (match[2] && match[2] !== unit)) {
          return `filters.${filterKey} must be a numeric string${unit ? ` with optional ${unit}` : ''}`;
        }
        const numeric = Number(match[1]);
        const [min, max] = FILTER_RANGES[filterKey] ?? [
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
        ];
        if (numeric < min || numeric > max) {
          return `filters.${filterKey} out of bounds (${min}..${max})`;
        }
      }
      return null;
    }
    case 'themeColors':
      if (!Array.isArray(value) || value.length === 0 || !value.every(isColorString)) {
        return 'themeColors must be a non-empty array of color strings';
      }
      return null;
    default:
      return null;
  }
}

/**
 * Validate non-geometry prop values. Returns an error string or null.
 * Geometry is handled by clampUpdateProps.
 */
export function validatePropValue(key: string, value: unknown, type: string): string | null {
  const schema = getEditablePropSchema(type, key);
  if (!schema) return `${key} is not valid on ${type} elements`;

  const schemaErr = validateJsonSchemaSubset(value, schema, key);
  if (schemaErr) return schemaErr;

  return validatePolicyOverlay(key, value);
}

/**
 * Clamp geometry the same way gesture cores do: min size per type; rotate
 * normalized to (-180, 180]. Line `width` is stroke thickness (min 1), not box size.
 */
export function clampUpdateProps(
  type: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };

  if ('width' in out) {
    if (!isFiniteNumber(out.width)) throw new Error(`width must be a finite number`);
    const width = out.width;
    if (type === 'line') {
      out.width = Math.min(LINE_STROKE_MAX, Math.max(LINE_STROKE_MIN, width));
    } else {
      const clampedWidth = Math.max(minSizeFor(type), width);
      out.width = clampCoord(clampedWidth, 'width');
    }
  }
  if ('height' in out) {
    if (!isFiniteNumber(out.height)) throw new Error(`height must be a finite number`);
    if (type === 'line') throw new Error(`line elements have no height`);
    const height = out.height;
    const clampedHeight = Math.max(minSizeFor(type), height);
    out.height = clampCoord(clampedHeight, 'height');
  }
  if ('left' in out) {
    if (!isFiniteNumber(out.left)) throw new Error(`left must be a finite number`);
    out.left = clampCoord(out.left, 'left');
  }
  if ('top' in out) {
    if (!isFiniteNumber(out.top)) throw new Error(`top must be a finite number`);
    out.top = clampCoord(out.top, 'top');
  }
  if ('rotate' in out) {
    if (type === 'line') throw new Error(`line elements have no rotate`);
    if (!isFiniteNumber(out.rotate)) throw new Error(`rotate must be a finite number`);
    out.rotate = normalizeRotate(out.rotate);
  }
  if ('opacity' in out) {
    if (!isFiniteNumber(out.opacity)) throw new Error(`opacity must be a finite number`);
    out.opacity = Math.min(1, Math.max(0, out.opacity));
  }
  if ('filters' in out) {
    const filters = out.filters as Record<string, string>;
    out.filters = Object.fromEntries(
      Object.entries(filters).map(([key, value]) => {
        const unit = FILTER_UNITS[key];
        const trimmed = value.trim();
        return [key, unit && trimmed.endsWith(unit) ? trimmed.slice(0, -unit.length) : trimmed];
      }),
    );
  }

  return out;
}

function validatePropsKeys(props: Record<string, unknown>): string | null {
  const keys = Object.keys(props);
  if (keys.length === 0) return 'update has empty props';
  for (const key of keys) {
    if (FORBIDDEN_EDIT_PROPS.has(key)) {
      return `prop ${JSON.stringify(key)} is not editable via edit_elements`;
    }
    if (!ALLOWED_EDIT_PROPS.has(key)) {
      return `prop ${JSON.stringify(key)} is out of contract`;
    }
  }
  return null;
}

function enforceGroupCohesion(
  updates: Array<{ id: string; props: Partial<PPTElement> }>,
  inventory: ElementInventoryItem[],
): string | null {
  const byId = new Map(inventory.map((el) => [el.id, el]));
  const updateById = new Map(updates.map((update) => [update.id, update]));
  const targeted = new Set(updates.map((u) => u.id));
  const checkedGroups = new Set<string>();
  for (const id of targeted) {
    const el = byId.get(id);
    if (!el?.groupId || checkedGroups.has(el.groupId)) continue;
    checkedGroups.add(el.groupId);
    const members = inventory.filter((x) => x.groupId === el.groupId);
    const missing = members.filter((member) => !targeted.has(member.id)).map((member) => member.id);
    if (missing.length > 0) {
      return `group ${JSON.stringify(el.groupId)} must be edited as a unit (missing ${missing.map((m) => JSON.stringify(m)).join(', ')})`;
    }

    for (const member of members) {
      const props = updateById.get(member.id)?.props ?? {};
      if ('height' in props || 'rotate' in props || (member.type !== 'line' && 'width' in props)) {
        return `group ${JSON.stringify(el.groupId)} does not support resize or rotate edits`;
      }
    }

    for (const axis of ['left', 'top'] as const) {
      const deltas = members.map((member) => {
        const next = updateById.get(member.id)?.props[axis];
        return (typeof next === 'number' ? next : member[axis]) - member[axis];
      });
      if (deltas.some((delta) => Math.abs(delta - deltas[0]) > GROUP_TRANSLATION_TOLERANCE)) {
        return `group ${JSON.stringify(el.groupId)} must use one rigid translation delta for ${axis}`;
      }
    }
  }
  return null;
}

function contextualProposalError(
  element: ElementInventoryItem,
  props: Record<string, unknown>,
  composedTextVisible?: boolean,
): string | null {
  if (!PRO_EDITOR_SUPPORTED_TYPES.has(element.type)) {
    return `${element.type} elements are not editable in the active Pro editor`;
  }
  if (element.type === 'text' && 'vAlign' in props) {
    return 'vAlign is not rendered for text elements in the active Pro editor';
  }
  if (element.type === 'latex' && element.latexRenderMode === 'none') {
    return 'latex element has no renderable HTML or SVG branch';
  }
  if (
    element.type === 'text' &&
    element.hasTextGlyphs === false &&
    Object.keys(props).some((key) => TEXT_GLYPH_PROPS.has(key))
  ) {
    if (composedTextVisible !== true) {
      return 'text glyph chrome is not visible without painted text content';
    }
  }
  const hasIndividuallyEffectiveProp = Object.entries(props).some(([key, value]) =>
    propChangesEffectiveState(element, key, value),
  );
  if (element.type === 'text' && element.hasTextGlyphs === false && hasIndividuallyEffectiveProp) {
    const currentVisible = textBoxPaintVisible(element.style, {});
    const nextVisible = composedTextVisible === true || textBoxPaintVisible(element.style, props);
    if (!currentVisible && !nextVisible) {
      return 'text element has no visible paint before or after the proposed update';
    }
  }
  if (
    (element.type === 'shape' || element.type === 'line' || element.type === 'latex') &&
    hasIndividuallyEffectiveProp &&
    !elementPaintVisible(element, {}) &&
    !elementPaintVisible(element, props)
  ) {
    return `${element.type} element has no visible paint before or after the proposed update`;
  }
  if (
    element.type === 'shape' &&
    !element.hasShapeText &&
    composedTextVisible !== true &&
    Object.keys(props).some((key) => SHAPE_TEXT_CHROME_PROPS.has(key) || key === 'vAlign')
  ) {
    return 'shape text chrome is not visible without a shape label';
  }
  if (element.type === 'latex' && 'color' in props && element.hasInlineLatexColor) {
    return 'inline KaTeX color overrides the latex element color';
  }
  if (
    element.type === 'latex' &&
    element.latexRenderMode !== 'svg' &&
    ('width' in props || 'height' in props)
  ) {
    return 'latex resizing is not rendered consistently across app and package surfaces';
  }
  if (element.type === 'shape' && 'fill' in props && 'gradient' in props) {
    return 'fill and gradient are mutually exclusive shape paint edits';
  }
  if (element.type === 'table' && 'outline' in props) {
    if (element.hasCellBorders) {
      return 'table outline is not consistent across renderers when cells have explicit borders';
    }
    const patch = props.outline as Record<string, unknown>;
    if (patch.style === 'dotted') {
      return 'dotted table outlines are not rendered distinctly from solid outlines';
    }
  }
  if (
    element.type === 'chart' &&
    'lineColor' in props &&
    (element.chartType === 'pie' || element.chartType === 'ring')
  ) {
    return `lineColor is not rendered for ${element.chartType} charts`;
  }
  if (
    element.type === 'chart' &&
    element.hasRenderableChartData === false &&
    Object.keys(props).some(
      (key) => key === 'themeColors' || key === 'textColor' || key === 'lineColor',
    )
  ) {
    return 'chart colors are not visible without a non-empty data series';
  }
  if ('outline' in props) {
    const hasCurrentOutline = isRecord(element.style.outline);
    const current: Record<string, unknown> = hasCurrentOutline
      ? (element.style.outline as Record<string, unknown>)
      : {};
    const patch = props.outline as Record<string, unknown>;
    const next = { ...current, ...patch };
    const currentWidth = isFiniteNumber(current.width)
      ? current.width
      : element.type === 'table' && hasCurrentOutline
        ? 1
        : 0;
    const nextWidth = isFiniteNumber(next.width) ? next.width : element.type === 'table' ? 1 : 0;
    if (currentWidth === 0 && nextWidth === 0) {
      return 'outline edit has no visible width';
    }
  }
  if ('radius' in props && element.type === 'image') {
    const clipShape = element.imageClipShape ?? 'rect';
    if (clipShape !== 'rect' && clipShape !== 'roundRect') {
      return `radius is not rendered for image clip ${JSON.stringify(clipShape)}`;
    }
  }
  return null;
}

function visibleColor(value: unknown): boolean {
  return isColorString(value) && canonicalColor(value) !== canonicalColor('transparent');
}

function visibleOutline(
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): boolean {
  const outline = patch ? { ...current, ...patch } : current;
  return (
    isFiniteNumber(outline.width) && outline.width > 0 && visibleColor(outline.color ?? '#d14424')
  );
}

function textBoxPaintVisible(
  style: Record<string, unknown>,
  props: Record<string, unknown>,
): boolean {
  const opacity = 'opacity' in props ? props.opacity : (style.opacity ?? 1);
  if (!isFiniteNumber(opacity) || Math.min(1, Math.max(0, opacity)) === 0) return false;
  const fill = 'fill' in props ? props.fill : style.fill;
  const currentOutline = isRecord(style.outline) ? style.outline : {};
  const outlinePatch = isRecord(props.outline) ? props.outline : undefined;
  return visibleColor(fill) || visibleOutline(currentOutline, outlinePatch);
}

function visibleGradient(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.colors) &&
    value.colors.some((stop) => isRecord(stop) && visibleColor(stop.color))
  );
}

function elementPaintVisible(
  element: ElementInventoryItem,
  props: Record<string, unknown>,
): boolean {
  if (element.type === 'line') {
    const width =
      'width' in props && isFiniteNumber(props.width)
        ? Math.min(LINE_STROKE_MAX, Math.max(LINE_STROKE_MIN, props.width))
        : element.width;
    return (
      width > 0 &&
      (element.lineHasVisiblePath === true || element.lineHasEndpointMarker === true) &&
      visibleColor('color' in props ? props.color : (element.style.color ?? '#333333'))
    );
  }
  if (element.type === 'latex') {
    if (element.latexRenderMode === 'html') return textVisibleWithProposal(element, props) === true;
    return element.latexRenderMode === 'svg'
      ? visibleColor('color' in props ? props.color : element.style.color)
      : false;
  }
  if (element.type !== 'shape') return true;
  const opacity = 'opacity' in props ? props.opacity : (element.style.opacity ?? 1);
  if (!isFiniteNumber(opacity) || Math.min(1, Math.max(0, opacity)) === 0) return false;
  const currentOutline = isRecord(element.style.outline) ? element.style.outline : {};
  const outlinePatch = isRecord(props.outline) ? props.outline : undefined;
  if (
    visibleOutline(currentOutline, outlinePatch) ||
    textVisibleWithProposal(element, props) === true
  ) {
    return true;
  }
  if (!('fill' in props) && !('gradient' in props) && element.hasPattern) return true;
  if ('fill' in props) return visibleColor(props.fill);
  const gradient = 'gradient' in props ? props.gradient : element.style.gradient;
  if (gradient !== undefined) return visibleGradient(gradient);
  return visibleColor(element.style.fill);
}

function currentInventoryValue(element: ElementInventoryItem, key: string): unknown {
  if (key === 'left' || key === 'top' || key === 'width') return element[key];
  if (key === 'height') return element.height;
  if (key === 'rotate') return element.rotate ?? 0;
  if (key === 'radius' && element.type === 'image' && element.style.radius === undefined) {
    return element.imageClipShape === 'roundRect' ? 10 : 0;
  }
  const current = element.style[key];
  if (current !== undefined) return current;
  if (key === 'opacity') return 1;
  if (key === 'flipH' || key === 'flipV' || key === 'fixedRatio' || key === 'vertical') {
    return false;
  }
  if (key === 'wordSpace') return 0;
  if (key === 'paragraphSpace' && (element.type === 'text' || element.type === 'shape')) return 5;
  if (key === 'vAlign' && element.type === 'shape') return 'middle';
  return undefined;
}

function canonicalColor(value: unknown): unknown {
  if (!isColorString(value)) return value;
  const color = tinycolor(String(value));
  return color.getAlpha() === 0 ? 'rgba(0, 0, 0, 0)' : color.toRgbString();
}

function normalizeThemeColors(value: unknown[], count: number): unknown[] {
  if (value.length === 0 || count === 0) return [];
  let colors: unknown[];
  if (value.length >= 10) {
    colors = value;
  } else if (value.length === 1) {
    colors = tinycolor(String(value[0]))
      .analogous(10)
      .map((color) => color.toRgbString());
  } else {
    const supplement = tinycolor(String(value[value.length - 1]))
      .analogous(11 - value.length)
      .map((color) => color.toRgbString());
    colors = [...value.slice(0, -1), ...supplement];
  }
  return colors.slice(0, count).map(canonicalColor);
}

function normalizeFilters(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      normalized[key] = raw;
      continue;
    }
    const unit = FILTER_UNITS[key];
    const trimmed = raw.trim();
    const numericText = unit && trimmed.endsWith(unit) ? trimmed.slice(0, -unit.length) : trimmed;
    let numeric = Number(numericText);
    if (!Number.isFinite(numeric)) {
      normalized[key] = raw;
      continue;
    }
    if (key === 'hue-rotate') numeric = ((numeric % 360) + 360) % 360;
    if (numeric !== FILTER_IDENTITY[key]) normalized[key] = numeric;
  }
  return normalized;
}

function normalizeEffectiveValue(
  element: ElementInventoryItem,
  key: string,
  value: unknown,
): unknown {
  if ((key === 'fill' || key === 'colorMask') && value === undefined) {
    return canonicalColor('transparent');
  }
  if (COLOR_STRING_PROPS.has(key)) return canonicalColor(value);
  if (key === 'rotate' && isFiniteNumber(value)) return normalizeRotate(value);
  if (key === 'radius' && isFiniteNumber(value) && element.type === 'image') {
    return Math.min(value, Math.min(element.width, element.height ?? element.width) / 2);
  }
  if (key === 'themeColors' && Array.isArray(value)) {
    return normalizeThemeColors(value, element.chartColorCount ?? value.length);
  }
  if (key === 'filters') return normalizeFilters(value);
  if (key === 'outline') {
    if (!isRecord(value)) return { width: 0 };
    const width = isFiniteNumber(value.width) ? value.width : element.type === 'table' ? 1 : 0;
    if (width === 0) return { width: 0 };
    const defaultColor = element.type === 'table' ? '#000000' : '#d14424';
    const color = canonicalColor(value.color ?? defaultColor);
    if (color === canonicalColor('transparent')) return { width: 0 };
    const style =
      value.style === 'dashed' || (element.type !== 'table' && value.style === 'dotted')
        ? value.style
        : 'solid';
    return {
      width,
      color,
      style,
    };
  }
  if (key === 'shadow') {
    if (!isRecord(value)) return null;
    const color = canonicalColor(value.color);
    if (color === canonicalColor('transparent')) return null;
    return { ...value, color };
  }
  if (key === 'gradient' && isRecord(value) && Array.isArray(value.colors)) {
    const type = value.type;
    const colors = value.colors.map((stop) =>
      isRecord(stop) ? { ...stop, color: canonicalColor(stop.color) } : stop,
    );
    const canonicalColors = colors
      .filter(isRecord)
      .map((stop) => stop.color)
      .filter((color) => color !== undefined);
    const monochrome =
      canonicalColors.length > 0 && canonicalColors.every((color) => color === canonicalColors[0]);
    if (monochrome) {
      return { type: 'solid-gradient', colors: [{ pos: 0, color: canonicalColors[0] }] };
    }
    const rotate =
      type === 'radial'
        ? undefined
        : isFiniteNumber(value.rotate)
          ? ((value.rotate % 360) + 360) % 360
          : value.rotate;
    return {
      ...value,
      ...(type === 'radial' ? { rotate: undefined } : { rotate }),
      colors,
    };
  }
  return value;
}

function propChangesEffectiveState(
  element: ElementInventoryItem,
  key: string,
  value: unknown,
): boolean {
  if (element.type === 'shape' && (key === 'fill' || key === 'gradient') && element.hasPattern) {
    return true;
  }
  if (key === 'fill' && element.type === 'shape' && element.style.gradient !== undefined) {
    const currentGradient = normalizeEffectiveValue(element, 'gradient', element.style.gradient);
    if (
      isRecord(currentGradient) &&
      currentGradient.type === 'solid-gradient' &&
      Array.isArray(currentGradient.colors) &&
      isRecord(currentGradient.colors[0]) &&
      currentGradient.colors[0].color === canonicalColor(value)
    ) {
      return false;
    }
    return true;
  }
  if (key === 'gradient' && element.type === 'shape' && element.style.gradient === undefined) {
    const nextGradient = normalizeEffectiveValue(element, key, value);
    if (
      isRecord(nextGradient) &&
      nextGradient.type === 'solid-gradient' &&
      Array.isArray(nextGradient.colors) &&
      isRecord(nextGradient.colors[0]) &&
      nextGradient.colors[0].color === normalizeEffectiveValue(element, 'fill', element.style.fill)
    ) {
      return false;
    }
  }
  const current = currentInventoryValue(element, key);
  if (MERGED_STYLE_PROPS.has(key) && isRecord(value)) {
    const currentRecord = isRecord(current) ? current : {};
    const next = { ...currentRecord, ...value };
    return !deepEqual(
      normalizeEffectiveValue(element, key, current),
      normalizeEffectiveValue(element, key, next),
    );
  }
  return !deepEqual(
    normalizeEffectiveValue(element, key, current),
    normalizeEffectiveValue(element, key, value),
  );
}

/**
 * Validate and coerce model proposals into EditIntents.
 * All-or-nothing: any single bad update refuses the whole batch.
 */
export function mapProposalsToEditIntents(
  proposals: ProposedElementUpdate[],
  inventory: ElementInventoryItem[],
): EditElementsGateResult {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { ok: false, reason: 'no element updates proposed' };
  }

  const byId = new Map(inventory.map((el) => [el.id, el]));
  const seen = new Set<string>();
  const updates: Array<{ id: string; props: Partial<PPTElement> }> = [];

  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== 'object') {
      return { ok: false, reason: 'malformed update entry' };
    }
    const { id, props } = proposal;
    if (typeof id !== 'string' || !id) {
      return { ok: false, reason: 'update missing element id' };
    }
    if (seen.has(id)) {
      return { ok: false, reason: `duplicate update for element ${JSON.stringify(id)}` };
    }
    seen.add(id);

    const el = byId.get(id);
    if (!el) {
      return { ok: false, reason: `unknown element id ${JSON.stringify(id)}` };
    }
    if (el.lock) {
      return { ok: false, reason: `element ${JSON.stringify(id)} is locked` };
    }
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      return { ok: false, reason: `malformed props for element ${JSON.stringify(id)}` };
    }

    const keyErr = validatePropsKeys(props);
    if (keyErr) return { ok: false, reason: keyErr };
    for (const [key, value] of Object.entries(props)) {
      const valueErr = validatePropValue(key, value, el.type);
      if (valueErr) return { ok: false, reason: valueErr };
    }

    const composedTextVisible = textVisibleWithProposal(el, props);
    const revealsUnpaintedTextWithDefaultColor = textPropContributesToVisibility(
      el,
      props,
      'defaultColor',
      composedTextVisible,
    );
    if ('defaultColor' in props && el.hasInlineTextColor && !revealsUnpaintedTextWithDefaultColor) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline text color that defaultColor cannot override`,
      };
    }
    if ('defaultFontName' in props && el.hasInlineFontFamily) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline font-family that defaultFontName cannot override`,
      };
    }
    if ('lineHeight' in props && el.hasInlineLineHeight) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline line-height that lineHeight cannot override`,
      };
    }
    if ('wordSpace' in props && el.hasInlineLetterSpacing) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline letter-spacing that wordSpace cannot override`,
      };
    }
    if ('paragraphSpace' in props && el.hasInlineParagraphSpacing) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline margin-bottom that paragraphSpace cannot override`,
      };
    }
    if ('vertical' in props && el.hasInlineWritingMode) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline writing-mode that vertical cannot override`,
      };
    }
    const revealsUnpaintedTextWithShadow = textPropContributesToVisibility(
      el,
      props,
      'shadow',
      composedTextVisible,
    );
    if (
      'shadow' in props &&
      el.type === 'text' &&
      el.hasInlineTextShadow &&
      !revealsUnpaintedTextWithShadow
    ) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} has inline text-shadow that shadow cannot override`,
      };
    }

    const contextErr = contextualProposalError(el, props, composedTextVisible);
    if (contextErr) return { ok: false, reason: contextErr };

    if (el.type === 'text') {
      const vertical = 'vertical' in props ? props.vertical === true : el.style.vertical === true;
      if (vertical && 'width' in props) {
        return {
          ok: false,
          reason: `element ${JSON.stringify(id)} has automatic width in vertical text mode`,
        };
      }
      if (!vertical && 'height' in props) {
        return {
          ok: false,
          reason: `element ${JSON.stringify(id)} has automatic height in horizontal text mode`,
        };
      }
    }

    let clamped: Record<string, unknown>;
    try {
      clamped = clampUpdateProps(el.type, props);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : `invalid geometry for ${JSON.stringify(id)}`,
      };
    }

    if (
      !Object.entries(clamped).some(([key, value]) => propChangesEffectiveState(el, key, value))
    ) {
      return { ok: false, reason: `element ${JSON.stringify(id)} update has no effective change` };
    }

    updates.push({ id, props: clamped as Partial<PPTElement> });
  }

  const groupErr = enforceGroupCohesion(updates, inventory);
  if (groupErr) return { ok: false, reason: groupErr };

  if (updates.length === 1) {
    return {
      ok: true,
      intents: [{ type: 'element.update', id: updates[0].id, props: updates[0].props }],
    };
  }
  return {
    ok: true,
    intents: [{ type: 'element.updateMany', updates }],
  };
}

function textVisibleWithProposal(
  element: ElementInventoryItem,
  props: Record<string, unknown>,
): boolean | undefined {
  const source = (element as InternalElementInventoryItem)[TEXT_VISIBILITY_SOURCE];
  if (!source) return undefined;
  return hasVisibleHtmlText(source.content, {
    color: source.colorProp in props ? props[source.colorProp] : source.color,
    opacity: 'opacity' in props ? props.opacity : source.opacity,
    shadow:
      'shadow' in props && isRecord(props.shadow)
        ? (props.shadow as TextVisibilitySource['shadow'])
        : source.shadow,
  });
}

function textPropContributesToVisibility(
  element: ElementInventoryItem,
  props: Record<string, unknown>,
  property: string,
  composedTextVisible: boolean | undefined,
): boolean {
  if (composedTextVisible !== true || !(property in props)) return false;
  const withoutProperty = { ...props };
  delete withoutProperty[property];
  return textVisibleWithProposal(element, withoutProperty) === false;
}

/** Build the model-visible inventory from trusted slide elements. */
export function buildElementInventory(elements: PPTElement[]): ElementInventoryItem[] {
  return elements.map((el) => {
    const style: Record<string, unknown> = {};
    for (const key of ALLOWED_EDIT_PROPS) {
      if (
        key === 'left' ||
        key === 'top' ||
        key === 'width' ||
        key === 'height' ||
        key === 'rotate'
      ) {
        continue;
      }
      if (el.type === 'shape' && (SHAPE_TEXT_CHROME_PROPS.has(key) || key === 'vAlign')) {
        const text = (el as { text?: Record<string, unknown> }).text;
        const mappedKey = key === 'vAlign' ? 'align' : key;
        const v = text?.[mappedKey];
        if (v !== undefined) style[key] = v;
        continue;
      }
      const v = (el as unknown as Record<string, unknown>)[key];
      if (v !== undefined) style[key] = v;
    }
    const label = elementLabel(el);
    const base: ElementInventoryItem = {
      id: el.id,
      type: el.type,
      left: el.left,
      top: el.top,
      width: el.width,
      lock: !!el.lock,
      label,
      style,
    };
    if (typeof el.groupId === 'string' && el.groupId) base.groupId = el.groupId;
    if (el.type === 'image') {
      base.imageClipShape = (el as { clip?: { shape?: string } }).clip?.shape?.trim() || 'rect';
    }
    if (el.type === 'line') {
      const line = el as {
        start?: unknown;
        end?: unknown;
        points?: unknown;
        broken?: unknown;
        broken2?: unknown;
        curve?: unknown;
        cubic?: unknown;
      };
      const start = line.start;
      const end = line.end;
      const validEndpoints =
        Array.isArray(start) && Array.isArray(end) && start.length >= 2 && end.length >= 2;
      const differsFromStart = (point: unknown) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        validEndpoints &&
        (point[0] !== start[0] || point[1] !== start[1]);
      const broken2Visible =
        Array.isArray(line.broken2) &&
        line.broken2.length >= 2 &&
        validEndpoints &&
        (Math.max(Number(start[0]), Number(end[0])) >= Math.max(Number(start[1]), Number(end[1]))
          ? line.broken2[0] !== start[0]
          : line.broken2[1] !== start[1]);
      const controlPathVisible = line.broken
        ? differsFromStart(line.broken)
        : line.broken2
          ? broken2Visible
          : line.curve
            ? differsFromStart(line.curve)
            : line.cubic
              ? Array.isArray(line.cubic) && line.cubic.some(differsFromStart)
              : false;
      base.lineHasVisiblePath =
        validEndpoints && (start[0] !== end[0] || start[1] !== end[1] || controlPathVisible);
      base.lineHasEndpointMarker =
        Array.isArray(line.points) &&
        line.points.some((point) => typeof point === 'string' && point);
    }
    if (el.type === 'shape') {
      const shape = el as {
        pattern?: unknown;
        opacity?: unknown;
        text?: { content?: unknown; defaultColor?: unknown };
      };
      base.hasPattern = !!shape.pattern;
      base.hasShapeText =
        typeof shape.text?.content === 'string' &&
        hasVisibleHtmlText(shape.text.content, {
          color: shape.text.defaultColor,
          opacity: shape.opacity,
        });
      if (typeof shape.text?.content === 'string') {
        Object.defineProperty(base, TEXT_VISIBILITY_SOURCE, {
          value: {
            content: shape.text.content,
            colorProp: 'defaultColor',
            color: shape.text.defaultColor,
            opacity: shape.opacity,
          } satisfies TextVisibilitySource,
        });
      }
    }
    if (el.type === 'latex') {
      const latex = el as { html?: unknown; path?: unknown; viewBox?: unknown; color?: unknown };
      const html = latex.html;
      const hasHtml =
        typeof html === 'string' &&
        hasVisibleHtmlText(html, { color: latex.color, ignorePaint: true });
      const hasPath =
        typeof latex.path === 'string' &&
        latex.path.trim().length > 0 &&
        Array.isArray(latex.viewBox) &&
        latex.viewBox.length >= 2 &&
        latex.viewBox.every((value) => isFiniteNumber(value) && value > 0);
      base.latexRenderMode =
        typeof html === 'string' && html.length > 0
          ? hasHtml
            ? 'html'
            : 'none'
          : hasPath
            ? 'svg'
            : 'none';
      base.hasRenderableLatex = base.latexRenderMode !== 'none';
      if (typeof html === 'string') {
        Object.defineProperty(base, TEXT_VISIBILITY_SOURCE, {
          value: {
            content: html,
            colorProp: 'color',
            color: latex.color,
          } satisfies TextVisibilitySource,
        });
        const inline = collectInlineStyleProperties(html);
        base.hasInlineLatexColor =
          inline.has('all') || inline.has('color') || inline.has('-webkit-text-fill-color');
      }
    }
    if (el.type === 'table') {
      const data = (el as { data?: unknown }).data;
      base.hasCellBorders =
        Array.isArray(data) &&
        data.some(
          (row) =>
            Array.isArray(row) &&
            row.some((cell) => {
              if (!isRecord(cell) || !isRecord(cell.borders)) return false;
              const borders = cell.borders;
              return ['top', 'bottom', 'left', 'right'].some((side) => !!borders[side]);
            }),
        );
    }
    if (el.type === 'chart') {
      const chart = el as { chartType?: unknown; data?: { series?: unknown } };
      const chartType = chart.chartType;
      if (typeof chartType === 'string') base.chartType = chartType;
      const series = chart.data?.series;
      const seriesArray: unknown[] = Array.isArray(series) ? series : [];
      base.hasRenderableChartData =
        seriesArray.length > 0 &&
        (chartType === 'pie' || chartType === 'ring'
          ? Array.isArray(seriesArray[0]) && seriesArray[0].length > 0
          : true);
      base.chartColorCount =
        chartType === 'pie' || chartType === 'ring'
          ? Array.isArray(seriesArray[0])
            ? seriesArray[0].length
            : 0
          : chartType === 'scatter'
            ? Array.isArray(seriesArray[0]) && seriesArray[0].length > 0
              ? 1
              : 0
            : seriesArray.length === 1 &&
                Array.isArray(seriesArray[0]) &&
                seriesArray[0].length === 0
              ? 0
              : seriesArray.length;
    }
    const textContent =
      el.type === 'text'
        ? (el as { content?: unknown }).content
        : el.type === 'shape'
          ? (el as { text?: { content?: unknown } }).text?.content
          : undefined;
    if (typeof textContent === 'string') {
      if (el.type === 'text') {
        const text = el as {
          defaultColor?: unknown;
          opacity?: unknown;
          shadow?: { h?: unknown; v?: unknown; blur?: unknown; color?: unknown };
        };
        const visibilityOptions = {
          color: text.defaultColor,
          opacity: text.opacity,
          shadow: text.shadow,
        };
        base.hasTextGlyphs = hasVisibleHtmlText(textContent, visibilityOptions);
        base.hasTextContent = hasVisibleHtmlText(textContent, {
          ...visibilityOptions,
          ignorePaint: true,
        });
        Object.defineProperty(base, TEXT_VISIBILITY_SOURCE, {
          value: {
            content: textContent,
            colorProp: 'defaultColor',
            ...visibilityOptions,
          } satisfies TextVisibilitySource,
        });
      }
      const inline = collectInlineStyleProperties(textContent);
      const has = (...properties: string[]) => properties.some((property) => inline.has(property));
      if (has('color', '-webkit-text-fill-color')) base.hasInlineTextColor = true;
      if (has('font-family', 'font')) base.hasInlineFontFamily = true;
      if (has('line-height', 'font')) base.hasInlineLineHeight = true;
      if (has('letter-spacing')) base.hasInlineLetterSpacing = true;
      if (has('margin-bottom', 'margin', 'margin-block', 'margin-block-end', '--paragraphSpace')) {
        base.hasInlineParagraphSpacing = true;
      }
      if (has('writing-mode', '-webkit-writing-mode')) base.hasInlineWritingMode = true;
      if (has('text-shadow')) base.hasInlineTextShadow = true;
    }
    if (el.type !== 'line') {
      base.height = (el as { height: number }).height;
      base.rotate = (el as { rotate: number }).rotate;
    }
    return base;
  });
}

function hasVisibleHtmlText(
  content: string,
  options: {
    color?: unknown;
    opacity?: unknown;
    shadow?: { h?: unknown; v?: unknown; blur?: unknown; color?: unknown };
    ignorePaint?: boolean;
  } = {},
): boolean {
  type VisibilityState = {
    hidden: boolean;
    visibilityHidden: boolean;
    fontSizeZero: boolean;
    colorTransparent: boolean;
    textFillTransparent?: boolean;
    textShadowValue?: string;
  };
  const rootColorTransparent =
    typeof options.color === 'string' ? (cssColorTransparency(options.color) ?? false) : false;
  const rootShadow = options.shadow;
  const rootShadowValue =
    rootShadow &&
    isFiniteNumber(rootShadow.h) &&
    isFiniteNumber(rootShadow.v) &&
    isFiniteNumber(rootShadow.blur) &&
    typeof rootShadow.color === 'string'
      ? `${rootShadow.h}px ${rootShadow.v}px ${rootShadow.blur}px ${rootShadow.color}`
      : undefined;
  const rootState: VisibilityState = {
    hidden:
      !options.ignorePaint && isFiniteNumber(options.opacity)
        ? Math.min(1, Math.max(0, options.opacity)) === 0
        : false,
    visibilityHidden: false,
    fontSizeZero: false,
    colorTransparent: rootColorTransparent,
    textFillTransparent: undefined,
    textShadowValue: rootShadowValue,
  };
  const visibilityStack: VisibilityState[] = [];
  let visibleText = '';
  const tokens = tokenizeHtml(content);
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'source',
    'track',
    'wbr',
  ]);
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const state = visibilityStack.at(-1) ?? rootState;
      const transparentPaint =
        state?.textFillTransparent === true ||
        (state?.textFillTransparent === undefined && state?.colorTransparent);
      const shadowVisible = state?.textShadowValue
        ? textShadowIsVisible(state.textShadowValue, state.colorTransparent)
        : false;
      if (
        !state?.hidden &&
        !state?.visibilityHidden &&
        !state?.fontSizeZero &&
        (options.ignorePaint || !transparentPaint || shadowVisible)
      ) {
        visibleText += token;
      }
      continue;
    }
    if (/^<\s*[!/]/.test(token)) {
      if (/^<\s*\//.test(token)) visibilityStack.pop();
      continue;
    }
    const tag = token.match(/^<\s*([\w:-]+)/)?.[1]?.toLowerCase();
    if (!tag) continue;
    const parent = visibilityStack.at(-1) ?? rootState;
    const attributes = htmlAttributeVisibility(token);
    const colorTransparent = attributes.colorTransparent ?? parent.colorTransparent;
    const state: VisibilityState = {
      hidden: parent.hidden || attributes.hidden,
      visibilityHidden: attributes.visibilityHidden ?? parent.visibilityHidden,
      fontSizeZero: attributes.fontSizeZero ?? parent.fontSizeZero,
      colorTransparent,
      textFillTransparent: attributes.resetTextFill
        ? undefined
        : (attributes.textFillTransparent ?? parent.textFillTransparent),
      textShadowValue: attributes.textShadowValue ?? parent.textShadowValue,
    };
    if (!token.endsWith('/>') && !voidTags.has(tag)) visibilityStack.push(state);
  }
  return (
    visibleText
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ')
      .replace(/\s+/g, '').length > 0
  );
}

function tokenizeHtml(content: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== '<') {
      const next = content.indexOf('<', index);
      const end = next < 0 ? content.length : next;
      tokens.push(content.slice(index, end));
      index = end;
      continue;
    }
    let end = index + 1;
    let quote = '';
    while (end < content.length) {
      const char = content[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end++;
        break;
      }
      end++;
    }
    tokens.push(content.slice(index, end));
    index = end;
  }
  return tokens;
}

function htmlAttributeVisibility(tag: string): {
  hidden: boolean;
  visibilityHidden?: boolean;
  fontSizeZero?: boolean;
  colorTransparent?: boolean;
  textFillTransparent?: boolean;
  resetTextFill?: boolean;
  textShadowValue?: string;
} {
  const hiddenAttribute = /\shidden(?:\s*=\s*(?:["'][^"']*["']|[^\s>]+))?(?=\s|\/?>)/i.test(tag);
  const className = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? '';
  const classNames = className.split(/\s+/);
  let displayHidden = classNames.includes('hidden');
  let opacityHidden = false;
  let visibilityHidden = classNames.includes('invisible')
    ? true
    : classNames.includes('visible')
      ? false
      : undefined;
  let fontSizeZero: boolean | undefined;
  const style = tag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i)?.[2];
  let colorTransparent: boolean | undefined;
  let textFillTransparent: boolean | undefined;
  let resetTextFill = false;
  let textShadowValue: string | undefined;
  if (!style) return { hidden: hiddenAttribute || displayHidden, visibilityHidden };
  for (const [property, value] of winningInlineDeclarations(style)) {
    if (property === 'display') {
      if (value === 'none') displayHidden = true;
      else if (value === 'revert-layer') {
        // Preserve the lower author-layer class winner.
      } else if (isValidVisibleDisplayValue(value)) displayHidden = false;
    }
    if (property === 'visibility') {
      if (value === 'hidden' || value === 'collapse') visibilityHidden = true;
      else if (value === 'visible' || value === 'initial') {
        visibilityHidden = false;
      } else if (value === 'inherit' || value === 'unset' || value === 'revert') {
        visibilityHidden = undefined;
      } else if (value === 'revert-layer') {
        // Preserve the lower author-layer class winner.
      }
    }
    if (property === 'opacity') {
      const opacity = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%?$/);
      opacityHidden = opacity
        ? Number(opacity[1]) === 0
        : /^(?:initial|inherit|unset|revert|revert-layer)$/.test(value)
          ? false
          : true;
    }
    if (property === 'font-size') {
      const size = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:px|pt|pc|em|rem|%)?$/i);
      if (size) fontSizeZero = Number(size[1]) === 0;
      else if (value === 'initial') fontSizeZero = false;
      else if (
        value === 'inherit' ||
        value === 'unset' ||
        value === 'revert' ||
        value === 'revert-layer'
      ) {
        fontSizeZero = undefined;
      } else {
        fontSizeZero = true;
      }
    }
    if (property === 'color') {
      colorTransparent = value === 'initial' ? false : cssColorTransparency(value);
      if (
        value === 'inherit' ||
        value === 'unset' ||
        value === 'revert' ||
        value === 'revert-layer' ||
        value === 'currentcolor'
      ) {
        colorTransparent = undefined;
      } else if (colorTransparent === undefined) {
        colorTransparent = true;
      }
    }
    if (property === '-webkit-text-fill-color') {
      if (value === 'initial' || value === 'currentcolor') {
        resetTextFill = true;
        textFillTransparent = undefined;
      } else if (
        value === 'inherit' ||
        value === 'unset' ||
        value === 'revert' ||
        value === 'revert-layer'
      ) {
        resetTextFill = false;
        textFillTransparent = undefined;
      } else {
        textFillTransparent = cssColorTransparency(value) ?? true;
      }
    }
    if (property === 'text-shadow') {
      textShadowValue =
        value === 'initial' || value === 'none'
          ? 'none'
          : value === 'inherit' ||
              value === 'unset' ||
              value === 'revert' ||
              value === 'revert-layer'
            ? undefined
            : value;
    }
  }
  return {
    hidden: hiddenAttribute || displayHidden || opacityHidden,
    visibilityHidden,
    fontSizeZero,
    colorTransparent,
    textFillTransparent,
    resetTextFill,
    textShadowValue,
  };
}

function winningInlineDeclarations(style: string): Map<string, string> {
  const allProperties = [
    'display',
    'opacity',
    'visibility',
    'font-size',
    'color',
    '-webkit-text-fill-color',
    'text-shadow',
    'font-family',
    'line-height',
    'letter-spacing',
    'margin',
    'margin-bottom',
    'margin-block',
    'margin-block-end',
    'writing-mode',
    '-webkit-writing-mode',
  ];
  const cssWideValues = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
  const winners = new Map<string, { value: string; important: boolean }>();
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!property) continue;
    const rawValue = declaration.slice(colon + 1).trim();
    const important = /!important\s*$/i.test(rawValue);
    const value = rawValue
      .replace(/!important\s*$/i, '')
      .trim()
      .toLowerCase();
    if (property !== 'all' && !isValidTrackedCssDeclaration(property, value, cssWideValues)) {
      continue;
    }
    const targets: Array<[string, string]> =
      property === 'all'
        ? cssWideValues.has(value)
          ? allProperties.map((target) => [target, value])
          : []
        : property === 'font'
          ? [
              ['font-size', fontShorthandSize(value) ?? value],
              ['font-family', value],
              ['line-height', value],
            ]
          : [[property, value]];
    for (const [target, targetValue] of targets) {
      const current = winners.get(target);
      if (!current || important || !current.important) {
        winners.set(target, { value: targetValue, important });
      }
    }
  }
  return new Map(Array.from(winners, ([property, winner]) => [property, winner.value]));
}

function isValidTrackedCssDeclaration(
  property: string,
  value: string,
  cssWideValues: ReadonlySet<string>,
): boolean {
  if (cssWideValues.has(value)) return true;
  if (property === 'display') return value === 'none' || isValidVisibleDisplayValue(value);
  if (property === 'visibility') return /^(?:visible|hidden|collapse)$/.test(value);
  if (property === 'opacity') {
    return (
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value) ||
      /^(?:calc|min|max|clamp|var)\(.+\)$/.test(value)
    );
  }
  if (property === 'font-size') return fontSizeValue(value) !== undefined;
  if (property === 'font') return fontShorthandSize(value) !== undefined;
  if (property === 'color' || property === '-webkit-text-fill-color') {
    return (
      value === 'currentcolor' ||
      isColorString(value) ||
      cssColorTransparency(value) !== undefined ||
      /^(?:color|color-mix|lab|lch|oklab|oklch|var)\(.+\)$/.test(value)
    );
  }
  if (property === 'writing-mode' || property === '-webkit-writing-mode') {
    return /^(?:horizontal-tb|vertical-rl|vertical-lr|sideways-rl|sideways-lr)$/.test(value);
  }
  if (property === 'text-shadow') {
    return value === 'none' || isValidTextShadowValue(value);
  }
  return value.length > 0;
}

function fontSizeValue(value: string): string | undefined {
  return /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|0|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|pt|pc|in|cm|mm|q|em|rem|ex|ch|lh|rlh|vw|vh|vmin|vmax|%)|(?:calc|min|max|clamp|var)\(.+\))$/.test(
    value,
  )
    ? value
    : undefined;
}

function fontShorthandSize(value: string): string | undefined {
  if (/^(?:initial|inherit|unset|revert|revert-layer)$/.test(value)) return value;
  if (/^(?:caption|icon|menu|message-box|small-caption|status-bar)$/.test(value)) return 'initial';
  const match = value.match(
    /(?:^|\s)(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|0|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|pt|pc|in|cm|mm|q|em|rem|ex|ch|lh|rlh|vw|vh|vmin|vmax|%))(?=\s|\/)/,
  );
  return match?.[1];
}

function isValidVisibleDisplayValue(value: string): boolean {
  if (
    /^(?:block|inline|run-in|flow|flow-root|table|flex|grid|ruby|list-item|contents|inline-(?:block|table|flex|grid)|table-(?:row-group|header-group|footer-group|row|cell|column-group|column|caption)|ruby-(?:base|text|base-container|text-container)|initial|inherit|unset|revert)$/i.test(
      value,
    )
  ) {
    return true;
  }
  const tokens = value.split(/\s+/);
  const listItem = tokens.at(-1) === 'list-item';
  if (listItem) tokens.pop();
  const outside = new Set(['block', 'inline', 'run-in']);
  const inside = new Set(['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby']);
  const validPair =
    (tokens.length === 1 && (outside.has(tokens[0]) || inside.has(tokens[0]))) ||
    (tokens.length === 2 && outside.has(tokens[0]) && inside.has(tokens[1]));
  if (!listItem) return validPair;
  const listInside = new Set(['flow', 'flow-root']);
  return (
    tokens.length === 0 ||
    (tokens.length === 1 && (outside.has(tokens[0]) || listInside.has(tokens[0]))) ||
    (tokens.length === 2 && outside.has(tokens[0]) && listInside.has(tokens[1]))
  );
}

function isValidTextShadowValue(value: string): boolean {
  if (/^var\(.+\)$/.test(value)) return true;
  return splitCssList(value).every((layer) => {
    let lengthCount = 0;
    let colorCount = 0;
    for (const token of splitCssTokens(layer.trim())) {
      if (
        token === '0' ||
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|vh|vmin|vmax)$/.test(
          token,
        ) ||
        /^(?:calc|min|max|clamp)\(.+\)$/.test(token)
      ) {
        lengthCount++;
        continue;
      }
      if (
        token === 'currentcolor' ||
        isColorString(token) ||
        cssColorTransparency(token) !== undefined ||
        /^(?:color|color-mix|lab|lch|oklab|oklch|var)\(.+\)$/.test(token)
      ) {
        colorCount++;
        if (colorCount > 1) return false;
        continue;
      }
      return false;
    }
    return lengthCount >= 2 && lengthCount <= 3;
  });
}

function splitCssTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    const char = value[index];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if ((index === value.length || /\s/.test(char)) && depth === 0) {
      if (index > start) tokens.push(value.slice(start, index));
      start = index + 1;
    }
  }
  return tokens;
}

function cssColorTransparency(value: string): boolean | undefined {
  if (isColorString(value)) return tinycolor(value).getAlpha() === 0;
  const alpha =
    value.match(/^(?:rgba|hsla)\([^)]*(?:,|\/)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))%\s*\)$/i) ??
    value.match(/^[a-z][\w-]*\([^)]*\/\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))%?\s*\)$/i);
  if (alpha) return Number(alpha[1]) === 0;
  return undefined;
}

function textShadowIsVisible(value: string, currentColorTransparent: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'initial' || normalized.startsWith('revert')) {
    return false;
  }
  if (/\b(?:var|color|color-mix|lab|lch|oklab|oklch)\(/.test(normalized)) return false;
  for (const shadow of splitCssList(value)) {
    const candidates = shadow.match(/(?:rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}|\b[a-z]+\b/gi) ?? [];
    let foundColor = false;
    let layerVisible = false;
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (lower === 'currentcolor') {
        foundColor = true;
        layerVisible ||= !currentColorTransparent;
        continue;
      }
      const transparency = cssColorTransparency(candidate);
      if (!isColorString(candidate) && transparency === undefined) continue;
      if (
        !lower.startsWith('rgb') &&
        !lower.startsWith('hsl') &&
        !lower.startsWith('#') &&
        !Object.hasOwn(tinycolor.names, lower) &&
        lower !== 'transparent'
      ) {
        continue;
      }
      foundColor = true;
      layerVisible ||= transparency === false;
    }
    if (layerVisible || (!foundColor && !currentColorTransparent)) return true;
  }
  return false;
}

function splitCssList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

function collectInlineStyleProperties(content: string): Set<string> {
  const properties = new Set<string>();
  const styleAttribute = /\bstyle\s*=\s*(["'])(.*?)\1/gi;
  for (const match of content.matchAll(styleAttribute)) {
    for (const [property, value] of winningInlineDeclarations(match[2])) {
      const inheritsElementValue =
        value === 'inherit' || value === 'unset' || value === 'revert' || value === 'revert-layer';
      if (
        inheritsElementValue &&
        [
          'color',
          '-webkit-text-fill-color',
          'font-family',
          'font',
          'line-height',
          'letter-spacing',
          'writing-mode',
          '-webkit-writing-mode',
          'text-shadow',
        ].includes(property)
      ) {
        continue;
      }
      if (
        (property === 'color' && value === 'currentcolor') ||
        (property === '-webkit-text-fill-color' &&
          (value === 'initial' || value === 'currentcolor'))
      ) {
        continue;
      }
      properties.add(property);
    }
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      if (property.startsWith('--')) properties.add(property);
    }
  }
  return properties;
}

/** Stable snapshot of the model-visible mutable state used for apply-time drift checks. */
export function elementInventoryFingerprint(element: PPTElement): string {
  const item = buildElementInventory([element])[0];
  return JSON.stringify({ item, applyDependencies: elementApplyDependencies(element) });
}

/** Stable snapshot of every prompt-visible element, including order and membership. */
export function elementInventorySnapshotFingerprint(elements: PPTElement[]): string {
  const inventory = buildElementInventory(elements);
  return JSON.stringify(
    inventory.map((item, index) => ({
      item,
      applyDependencies: elementApplyDependencies(elements[index]),
    })),
  );
}

function elementApplyDependencies(element: PPTElement): unknown {
  if (element.type === 'text') {
    return { content: (element as { content?: unknown }).content };
  }
  if (element.type === 'shape') {
    const shape = element as {
      pattern?: unknown;
      pathFormula?: unknown;
      keypoints?: unknown;
      text?: { content?: unknown };
    };
    return {
      pattern: shape.pattern,
      pathFormula: shape.pathFormula,
      keypoints: shape.keypoints,
      textContent: shape.text?.content,
    };
  }
  if (element.type === 'latex') {
    return { html: (element as { html?: unknown }).html };
  }
  if (element.type === 'table') {
    const table = element as {
      data?: unknown;
      cellMinHeight?: unknown;
      rowHeights?: unknown;
    };
    return {
      rowCount: Array.isArray(table.data) ? table.data.length : undefined,
      cellMinHeight: table.cellMinHeight,
      rowHeights: table.rowHeights,
    };
  }
  return undefined;
}

function elementLabel(el: PPTElement): string {
  if (typeof el.name === 'string' && el.name.trim()) return el.name.trim().slice(0, 80);
  const e = el as {
    type: string;
    content?: unknown;
    text?: { content?: unknown };
    textType?: string;
  };
  if (e.type === 'text' && typeof e.content === 'string') {
    const plain = e.content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 80);
    if (e.textType) return e.textType;
  }
  if (e.type === 'shape' && typeof e.text?.content === 'string') {
    const plain = e.text.content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 80);
  }
  return e.type;
}

/** Collect target element ids from a batch of EditIntents. */
export function collectIntentTargetIds(intents: EditIntent[]): string[] {
  const ids: string[] = [];
  for (const intent of intents) {
    if (intent.type === 'element.update') ids.push(intent.id);
    else if (intent.type === 'element.updateMany') {
      for (const u of intent.updates) ids.push(u.id);
    }
  }
  return ids;
}

/**
 * Apply-time revalidation against the live slide content.
 * Ensures the batch is still fully applicable (ids present, unlocked, group-cohesive).
 */
export function revalidateIntentsAgainstElements(
  elements: PPTElement[],
  intents: EditIntent[],
  targetElementTypes?: Record<string, string>,
  targetElementFingerprints?: Record<string, string>,
): EditElementsGateResult {
  const inventory = buildElementInventory(elements);
  const ids = collectIntentTargetIds(intents);
  if (ids.length === 0) return { ok: false, reason: 'no element updates proposed' };

  const byId = new Map(inventory.map((el) => [el.id, el]));
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) return { ok: false, reason: `unknown element id ${JSON.stringify(id)}` };
    if (el.lock) return { ok: false, reason: `element ${JSON.stringify(id)} is locked` };
    const expectedType = targetElementTypes?.[id];
    if (expectedType && el.type !== expectedType) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} changed type from ${expectedType} to ${el.type}`,
      };
    }
    const expectedFingerprint = targetElementFingerprints?.[id];
    const liveElement = elements.find((item) => item.id === id);
    if (
      expectedFingerprint &&
      liveElement &&
      elementInventoryFingerprint(liveElement) !== expectedFingerprint
    ) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} changed while the edit was being prepared`,
      };
    }
  }
  const groupErr = enforceGroupCohesion(
    intents.flatMap((intent) =>
      intent.type === 'element.update'
        ? [{ id: intent.id, props: intent.props }]
        : intent.type === 'element.updateMany'
          ? intent.updates
          : [],
    ),
    inventory,
  );
  if (groupErr) return { ok: false, reason: groupErr };
  return { ok: true, intents };
}
