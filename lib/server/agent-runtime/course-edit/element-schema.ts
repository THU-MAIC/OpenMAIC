/**
 * Closed TypeBox schemas for the slide DSL JSON exposed by `read_stage` and
 * written by `patch_stage`.
 *
 * A patch is a PARTIAL element JSON: every field optional, `additionalProperties`
 * closed at every level so an unknown or out-of-contract field fails loud
 * instead of silently landing in a document. Nested objects are themselves
 * partial patches (deep-merge semantics); arrays are validated against their
 * element types (array fields are replaced wholesale, never merged).
 *
 * Patch schemas omit `id` and `type` because identity is not patchable. The
 * insertion schema adds the discriminating `type`, still omits `id` (the
 * server owns identity), and restores every DSL-required field.
 *
 * Field sets mirror `@openmaic/dsl` `slides.ts` exactly (the 10-element union).
 */
import { Type, type TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { ElementTypes } from '@openmaic/dsl';

const optionalString = () => Type.Optional(Type.String());
const optionalNumber = () => Type.Optional(Type.Number());
const optionalBoolean = () => Type.Optional(Type.Boolean());

const LineStyleType = Type.Union([
  Type.Literal('solid'),
  Type.Literal('dashed'),
  Type.Literal('dotted'),
]);
const TextAlign = Type.Union([
  Type.Literal('left'),
  Type.Literal('center'),
  Type.Literal('right'),
  Type.Literal('justify'),
]);
const VAlign = Type.Union([Type.Literal('top'), Type.Literal('middle'), Type.Literal('bottom')]);
const TextType = Type.Union([
  Type.Literal('title'),
  Type.Literal('subtitle'),
  Type.Literal('content'),
  Type.Literal('item'),
  Type.Literal('itemTitle'),
  Type.Literal('notes'),
  Type.Literal('header'),
  Type.Literal('footer'),
  Type.Literal('partNumber'),
  Type.Literal('itemNumber'),
]);
const ImageType = Type.Union([
  Type.Literal('pageFigure'),
  Type.Literal('itemFigure'),
  Type.Literal('background'),
]);
const ChartType = Type.Union([
  Type.Literal('bar'),
  Type.Literal('column'),
  Type.Literal('line'),
  Type.Literal('pie'),
  Type.Literal('ring'),
  Type.Literal('area'),
  Type.Literal('radar'),
  Type.Literal('scatter'),
]);
const LinePoint = Type.Union([Type.Literal(''), Type.Literal('arrow'), Type.Literal('dot')]);
const ShapePathFormulas = Type.Union([
  Type.Literal('roundRect'),
  Type.Literal('roundRectDiagonal'),
  Type.Literal('roundRectSingle'),
  Type.Literal('roundRectSameSide'),
  Type.Literal('cutRectDiagonal'),
  Type.Literal('cutRectSingle'),
  Type.Literal('cutRectSameSide'),
  Type.Literal('cutRoundRect'),
  Type.Literal('message'),
  Type.Literal('roundMessage'),
  Type.Literal('L'),
  Type.Literal('ringRect'),
  Type.Literal('plus'),
  Type.Literal('triangle'),
  Type.Literal('parallelogramLeft'),
  Type.Literal('parallelogramRight'),
  Type.Literal('trapezoid'),
  Type.Literal('bullet'),
  Type.Literal('indicator'),
  Type.Literal('donut'),
  Type.Literal('diagStripe'),
]);

const Point = Type.Tuple([Type.Number(), Type.Number()]);

const Link = Type.Object(
  {
    type: Type.Union([Type.Literal('web'), Type.Literal('slide')]),
    target: Type.String(),
  },
  { additionalProperties: false },
);
const Outline = Type.Object(
  {
    style: Type.Optional(LineStyleType),
    width: optionalNumber(),
    color: optionalString(),
  },
  { additionalProperties: false },
);
const Shadow = Type.Object(
  {
    h: optionalNumber(),
    v: optionalNumber(),
    blur: optionalNumber(),
    color: optionalString(),
  },
  { additionalProperties: false },
);
const FullShadow = Type.Object(
  {
    h: Type.Number(),
    v: Type.Number(),
    blur: Type.Number(),
    color: Type.String(),
  },
  { additionalProperties: false },
);
const GradientColor = Type.Object(
  {
    pos: Type.Number(),
    color: Type.String(),
  },
  { additionalProperties: false },
);
const Gradient = Type.Object(
  {
    type: Type.Union([Type.Literal('linear'), Type.Literal('radial')]),
    colors: Type.Array(GradientColor),
    rotate: Type.Number(),
  },
  { additionalProperties: false },
);
const ShapeText = Type.Object(
  {
    content: optionalString(),
    defaultFontName: optionalString(),
    defaultColor: optionalString(),
    align: Type.Optional(VAlign),
    lineHeight: optionalNumber(),
    wordSpace: optionalNumber(),
    paragraphSpace: optionalNumber(),
    type: Type.Optional(TextType),
  },
  { additionalProperties: false },
);
const FullShapeText = Type.Object(
  {
    content: Type.String(),
    defaultFontName: Type.String(),
    defaultColor: Type.String(),
    align: VAlign,
    lineHeight: optionalNumber(),
    wordSpace: optionalNumber(),
    paragraphSpace: optionalNumber(),
    type: Type.Optional(TextType),
  },
  { additionalProperties: false },
);
const ImageFilters = Type.Object(
  {
    blur: optionalString(),
    brightness: optionalString(),
    contrast: optionalString(),
    grayscale: optionalString(),
    saturate: optionalString(),
    'hue-rotate': optionalString(),
    sepia: optionalString(),
    invert: optionalString(),
    opacity: optionalString(),
  },
  { additionalProperties: false },
);
const ImageClip = Type.Object(
  {
    range: Type.Tuple([Point, Point]),
    shape: Type.String(),
  },
  { additionalProperties: false },
);
const ChartData = Type.Object(
  {
    labels: Type.Array(Type.String()),
    legends: Type.Array(Type.String()),
    series: Type.Array(Type.Array(Type.Number())),
  },
  { additionalProperties: false },
);
const ChartOptions = Type.Object(
  {
    lineSmooth: optionalBoolean(),
    stack: optionalBoolean(),
  },
  { additionalProperties: false },
);
const TableCellStyle = Type.Object(
  {
    bold: optionalBoolean(),
    em: optionalBoolean(),
    underline: optionalBoolean(),
    strikethrough: optionalBoolean(),
    color: optionalString(),
    backcolor: optionalString(),
    fontsize: optionalString(),
    fontname: optionalString(),
    align: Type.Optional(TextAlign),
  },
  { additionalProperties: false },
);
const TableCellBorder = Type.Object(
  {
    width: Type.Number(),
    style: LineStyleType,
    color: Type.String(),
  },
  { additionalProperties: false },
);
const TableCell = Type.Object(
  {
    id: Type.String(),
    colspan: Type.Number(),
    rowspan: Type.Number(),
    text: Type.String(),
    style: Type.Optional(TableCellStyle),
    padding: optionalString(),
    vAlign: Type.Optional(VAlign),
    borders: Type.Optional(
      Type.Object(
        {
          top: Type.Optional(TableCellBorder),
          bottom: Type.Optional(TableCellBorder),
          left: Type.Optional(TableCellBorder),
          right: Type.Optional(TableCellBorder),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const TableTheme = Type.Object(
  {
    color: Type.String(),
    rowHeader: Type.Boolean(),
    rowFooter: Type.Boolean(),
    colHeader: Type.Boolean(),
    colFooter: Type.Boolean(),
  },
  { additionalProperties: false },
);
const CodeLine = Type.Object(
  {
    id: Type.String(),
    content: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Fields shared by every element kind (from `PPTBaseElement`), minus `id` —
 * identity is rejected before validation.
 */
const Common = {
  left: optionalNumber(),
  top: optionalNumber(),
  lock: optionalBoolean(),
  groupId: optionalString(),
  width: optionalNumber(),
  height: optionalNumber(),
  rotate: optionalNumber(),
  link: Type.Optional(Link),
  name: optionalString(),
};

const TextElementPatch = Type.Object(
  {
    ...Common,
    content: optionalString(),
    defaultFontName: optionalString(),
    defaultColor: optionalString(),
    outline: Type.Optional(Outline),
    fill: optionalString(),
    lineHeight: optionalNumber(),
    wordSpace: optionalNumber(),
    opacity: optionalNumber(),
    shadow: Type.Optional(Shadow),
    paragraphSpace: optionalNumber(),
    vertical: optionalBoolean(),
    textType: Type.Optional(TextType),
    vAlign: Type.Optional(VAlign),
  },
  { additionalProperties: false },
);
const ImageElementPatch = Type.Object(
  {
    ...Common,
    fixedRatio: optionalBoolean(),
    src: optionalString(),
    outline: Type.Optional(Outline),
    filters: Type.Optional(ImageFilters),
    clip: Type.Optional(ImageClip),
    flipH: optionalBoolean(),
    flipV: optionalBoolean(),
    shadow: Type.Optional(Shadow),
    radius: optionalNumber(),
    colorMask: optionalString(),
    imageType: Type.Optional(ImageType),
    softEdge: optionalNumber(),
  },
  { additionalProperties: false },
);
const ShapeElementPatch = Type.Object(
  {
    ...Common,
    viewBox: Type.Optional(Point),
    path: optionalString(),
    fixedRatio: optionalBoolean(),
    fill: optionalString(),
    gradient: Type.Optional(Gradient),
    pattern: optionalString(),
    outline: Type.Optional(Outline),
    opacity: optionalNumber(),
    flipH: optionalBoolean(),
    flipV: optionalBoolean(),
    shadow: Type.Optional(Shadow),
    special: optionalBoolean(),
    text: Type.Optional(ShapeText),
    pathFormula: Type.Optional(ShapePathFormulas),
    keypoints: Type.Optional(Type.Array(Type.Number())),
  },
  { additionalProperties: false },
);
const LineElementPatch = Type.Object(
  {
    left: optionalNumber(),
    top: optionalNumber(),
    lock: optionalBoolean(),
    groupId: optionalString(),
    width: optionalNumber(),
    link: Type.Optional(Link),
    name: optionalString(),
    start: Type.Optional(Point),
    end: Type.Optional(Point),
    style: Type.Optional(LineStyleType),
    color: optionalString(),
    points: Type.Optional(Type.Tuple([LinePoint, LinePoint])),
    shadow: Type.Optional(Shadow),
    broken: Type.Optional(Point),
    broken2: Type.Optional(Point),
    curve: Type.Optional(Point),
    cubic: Type.Optional(Type.Tuple([Point, Point])),
  },
  { additionalProperties: false },
);
const ChartElementPatch = Type.Object(
  {
    ...Common,
    fill: optionalString(),
    chartType: Type.Optional(ChartType),
    data: Type.Optional(ChartData),
    options: Type.Optional(ChartOptions),
    outline: Type.Optional(Outline),
    themeColors: Type.Optional(Type.Array(Type.String())),
    textColor: optionalString(),
    lineColor: optionalString(),
  },
  { additionalProperties: false },
);
const TableElementPatch = Type.Object(
  {
    ...Common,
    outline: Type.Optional(Outline),
    theme: Type.Optional(TableTheme),
    colWidths: Type.Optional(Type.Array(Type.Number())),
    cellMinHeight: optionalNumber(),
    rowHeights: Type.Optional(Type.Array(Type.Number())),
    data: Type.Optional(Type.Array(Type.Array(TableCell))),
  },
  { additionalProperties: false },
);
const LatexElementPatch = Type.Object(
  {
    ...Common,
    latex: optionalString(),
    html: optionalString(),
    path: optionalString(),
    color: optionalString(),
    strokeWidth: optionalNumber(),
    viewBox: Type.Optional(Point),
    fixedRatio: optionalBoolean(),
    align: Type.Optional(
      Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]),
    ),
  },
  { additionalProperties: false },
);
const VideoElementPatch = Type.Object(
  {
    ...Common,
    src: optionalString(),
    mediaRef: optionalString(),
    autoplay: optionalBoolean(),
    poster: optionalString(),
    ext: optionalString(),
  },
  { additionalProperties: false },
);
const AudioElementPatch = Type.Object(
  {
    ...Common,
    fixedRatio: optionalBoolean(),
    color: optionalString(),
    loop: optionalBoolean(),
    autoplay: optionalBoolean(),
    src: optionalString(),
    ext: optionalString(),
  },
  { additionalProperties: false },
);
const CodeElementPatch = Type.Object(
  {
    ...Common,
    language: optionalString(),
    lines: Type.Optional(Type.Array(CodeLine)),
    fileName: optionalString(),
    showLineNumbers: optionalBoolean(),
    fontSize: optionalNumber(),
  },
  { additionalProperties: false },
);

const ELEMENT_PATCH_SCHEMAS: Record<string, TSchema> = {
  [ElementTypes.TEXT]: TextElementPatch,
  [ElementTypes.IMAGE]: ImageElementPatch,
  [ElementTypes.SHAPE]: ShapeElementPatch,
  [ElementTypes.LINE]: LineElementPatch,
  [ElementTypes.CHART]: ChartElementPatch,
  [ElementTypes.TABLE]: TableElementPatch,
  [ElementTypes.LATEX]: LatexElementPatch,
  [ElementTypes.VIDEO]: VideoElementPatch,
  [ElementTypes.AUDIO]: AudioElementPatch,
  [ElementTypes.CODE]: CodeElementPatch,
};

const BASE_REQUIRED = ['left', 'top', 'width', 'height', 'rotate'];

/**
 * Build a creation schema from the matching patch schema so both operations
 * accept exactly the same field vocabulary. `required` restores the fields
 * that are mandatory on the full DSL element; nested objects that are partial
 * during a deep merge are tightened through `overrides` for creation.
 */
function fullElementSchema(
  type: string,
  patch: { properties: Record<string, TSchema> },
  required: string[],
  overrides: Record<string, TSchema> = {},
): TSchema {
  const schema = Type.Object(
    {
      type: Type.Literal(type),
      ...patch.properties,
      ...overrides,
    },
    { additionalProperties: false },
  );
  return { ...schema, required: ['type', ...required] };
}

const TextElementInput = fullElementSchema(
  ElementTypes.TEXT,
  TextElementPatch,
  [...BASE_REQUIRED, 'content', 'defaultFontName', 'defaultColor'],
  { shadow: Type.Optional(FullShadow) },
);
const ImageElementInput = fullElementSchema(
  ElementTypes.IMAGE,
  ImageElementPatch,
  [...BASE_REQUIRED, 'fixedRatio', 'src'],
  { shadow: Type.Optional(FullShadow) },
);
const ShapeElementInput = fullElementSchema(
  ElementTypes.SHAPE,
  ShapeElementPatch,
  [...BASE_REQUIRED, 'viewBox', 'path', 'fixedRatio', 'fill'],
  { shadow: Type.Optional(FullShadow), text: Type.Optional(FullShapeText) },
);
const LineElementInput = fullElementSchema(
  ElementTypes.LINE,
  LineElementPatch,
  ['left', 'top', 'width', 'start', 'end', 'style', 'color', 'points'],
  { shadow: Type.Optional(FullShadow) },
);
const ChartElementInput = fullElementSchema(ElementTypes.CHART, ChartElementPatch, [
  ...BASE_REQUIRED,
  'chartType',
  'data',
  'themeColors',
]);
const TableElementInput = fullElementSchema(ElementTypes.TABLE, TableElementPatch, [
  ...BASE_REQUIRED,
  'outline',
  'colWidths',
  'cellMinHeight',
  'data',
]);
const LatexElementInput = fullElementSchema(ElementTypes.LATEX, LatexElementPatch, [
  ...BASE_REQUIRED,
  'latex',
]);
const VideoElementInput = fullElementSchema(ElementTypes.VIDEO, VideoElementPatch, [
  ...BASE_REQUIRED,
  'autoplay',
]);
const AudioElementInput = fullElementSchema(ElementTypes.AUDIO, AudioElementPatch, [
  ...BASE_REQUIRED,
  'fixedRatio',
  'color',
  'loop',
  'autoplay',
  'src',
]);
const CodeElementInput = fullElementSchema(ElementTypes.CODE, CodeElementPatch, [
  ...BASE_REQUIRED,
  'language',
  'lines',
]);

/** Complete element JSON accepted by `add_element`; `id` is server-assigned. */
export const SlideElementInputSchema = Type.Union(
  [
    TextElementInput,
    ImageElementInput,
    ShapeElementInput,
    LineElementInput,
    ChartElementInput,
    TableElementInput,
    LatexElementInput,
    VideoElementInput,
    AudioElementInput,
    CodeElementInput,
  ],
  {
    description:
      'One COMPLETE slide element JSON without id. The server validates it and assigns id.',
  },
);

function persistedElementSchema(schema: TSchema): TSchema {
  const object = schema as TSchema & {
    properties: Record<string, TSchema>;
    required?: string[];
  };
  const persisted = Type.Object(
    {
      id: Type.String(),
      ...object.properties,
    },
    { additionalProperties: false },
  );
  return { ...persisted, required: ['id', ...(object.required ?? [])] };
}

/** Complete persisted element JSON, including the server-owned id. */
const PersistedSlideElementSchema = Type.Union([
  persistedElementSchema(TextElementInput),
  persistedElementSchema(ImageElementInput),
  persistedElementSchema(ShapeElementInput),
  persistedElementSchema(LineElementInput),
  persistedElementSchema(ChartElementInput),
  persistedElementSchema(TableElementInput),
  persistedElementSchema(LatexElementInput),
  persistedElementSchema(VideoElementInput),
  persistedElementSchema(AudioElementInput),
  persistedElementSchema(CodeElementInput),
]);

const SlideThemeSchema = Type.Object(
  {
    backgroundColor: Type.String(),
    themeColors: Type.Array(Type.String()),
    fontColor: Type.String(),
    fontName: Type.String(),
    outline: Type.Optional(Outline),
    shadow: Type.Optional(FullShadow),
  },
  { additionalProperties: false },
);
const SlideBackgroundSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('solid'), Type.Literal('image'), Type.Literal('gradient')]),
    color: Type.Optional(Type.String()),
    image: Type.Optional(
      Type.Object(
        {
          src: Type.String(),
          size: Type.Union([
            Type.Literal('cover'),
            Type.Literal('contain'),
            Type.Literal('repeat'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    gradient: Type.Optional(Gradient),
  },
  { additionalProperties: false },
);
const SlideAnimationSchema = Type.Object(
  {
    id: Type.String(),
    elId: Type.String(),
    effect: Type.String(),
    type: Type.Union([Type.Literal('in'), Type.Literal('out'), Type.Literal('attention')]),
    duration: Type.Number(),
    trigger: Type.Union([Type.Literal('click'), Type.Literal('meantime'), Type.Literal('auto')]),
  },
  { additionalProperties: false },
);
const SlideCanvasSchema = Type.Object(
  {
    id: Type.String(),
    viewportSize: Type.Number(),
    viewportRatio: Type.Number(),
    theme: SlideThemeSchema,
    elements: Type.Array(PersistedSlideElementSchema),
    background: Type.Optional(SlideBackgroundSchema),
    animations: Type.Optional(Type.Array(SlideAnimationSchema)),
    turningMode: Type.Optional(
      Type.Union(
        [
          'no',
          'fade',
          'slideX',
          'slideY',
          'random',
          'slideX3D',
          'slideY3D',
          'rotate',
          'scaleY',
          'scaleX',
          'scale',
          'scaleReverse',
        ].map((mode) => Type.Literal(mode)),
      ),
    ),
    sectionTag: Type.Optional(
      Type.Object(
        { id: Type.String(), title: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    type: Type.Optional(
      Type.Union(
        ['cover', 'contents', 'transition', 'content', 'end'].map((type) => Type.Literal(type)),
      ),
    ),
    script: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Validate a patch against the resolved element's type schema. Returns a list
 * of human-readable issues (empty when the patch is in contract).
 */
export function validateElementPatch(type: string, patch: Record<string, unknown>): string[] {
  const schema = ELEMENT_PATCH_SCHEMAS[type];
  if (!schema) return [`element type ${JSON.stringify(type)} is out of contract`];
  if (Check(schema, patch)) return [];
  return Errors(schema, patch).map((error) => `patch${error.instancePath || ''}: ${error.message}`);
}

/** Validate a complete, id-less element before the server assigns identity. */
export function validateElementInput(element: unknown): string[] {
  if (Check(SlideElementInputSchema, element)) return [];
  return Errors(SlideElementInputSchema, element).map(
    (error) => `element${error.instancePath || ''}: ${error.message}`,
  );
}

/** Validate the entire patched canvas, rejecting unknown fields at every level. */
export function validateSlideCanvas(canvas: unknown): string[] {
  if (Check(SlideCanvasSchema, canvas)) return [];
  return Errors(SlideCanvasSchema, canvas).map(
    (error) => `canvas${error.instancePath || ''}: ${error.message}`,
  );
}
