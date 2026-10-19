import type { PPTShapeElement, PPTTextElement, TextType } from '@openmaic/dsl';
import { decodeHTML } from 'entities';
import tinycolor from 'tinycolor2';

const TEXT_TYPES: ReadonlySet<string> = new Set<TextType>([
  'title',
  'subtitle',
  'content',
  'item',
  'itemTitle',
  'notes',
  'header',
  'footer',
  'partNumber',
  'itemNumber',
]);

/** One bounded text projection for generated and historical invalid shapes. */
export function shapeToTextFallback(shape: PPTShapeElement): PPTTextElement | null {
  const label = shape.text;
  if (!label || typeof label.content !== 'string') return null;
  const content = label.content.replace(/\x3c!--[\s\S]*?-->/g, '');
  // Decode after stripping tags so escaped markup remains visible text.
  const plain = decodeHTML(content.replace(/<[^>]*>/g, '')).trim();
  if (!plain && !/data-inline-math|<math\b|<img\b/i.test(content)) return null;

  const dimension = (value: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(value, 4000) : 100;
  const position = (value: number) =>
    Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : 0;
  const finite = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? value : undefined;
  const requestedColor = typeof label.defaultColor === 'string' ? label.defaultColor : '#333333';
  const color = tinycolor(requestedColor);
  const defaultColor = color.isValid() ? requestedColor : '#333333';
  const originalFill = tinycolor(shape.gradient?.colors?.[0]?.color || shape.fill);
  // A solid text backdrop keeps the default foreground legible when the path,
  // gradient or pattern disappears. Inline HTML colors remain author-controlled.
  const fill =
    originalFill.isValid() &&
    originalFill.getAlpha() === 1 &&
    tinycolor.readability(defaultColor, originalFill) >= 4.5
      ? originalFill.toRgbString()
      : tinycolor.mostReadable(defaultColor, ['#ffffff', '#111827'])!.toRgbString();

  return {
    type: 'text',
    id: shape.id,
    left: position(shape.left),
    top: position(shape.top),
    width: dimension(shape.width),
    height: dimension(shape.height),
    rotate: finite(shape.rotate) ?? 0,
    ...(typeof shape.groupId === 'string' ? { groupId: shape.groupId } : {}),
    ...(shape.link &&
    (shape.link.type === 'web' || shape.link.type === 'slide') &&
    typeof shape.link.target === 'string'
      ? { link: { type: shape.link.type, target: shape.link.target } }
      : {}),
    ...(typeof shape.lock === 'boolean' ? { lock: shape.lock } : {}),
    ...(typeof shape.name === 'string' ? { name: shape.name } : {}),
    content: label.content,
    defaultFontName:
      typeof label.defaultFontName === 'string' && label.defaultFontName
        ? label.defaultFontName
        : 'Microsoft YaHei',
    defaultColor,
    fill,
    vAlign: label.align === 'bottom' ? 'bottom' : label.align === 'top' ? 'top' : 'middle',
    lineHeight: finite(label.lineHeight) ?? 1.625,
    ...(finite(label.wordSpace) !== undefined ? { wordSpace: label.wordSpace } : {}),
    paragraphSpace: finite(label.paragraphSpace) ?? 5,
    ...(typeof label.type === 'string' && TEXT_TYPES.has(label.type)
      ? { textType: label.type as TextType }
      : {}),
    ...(finite(shape.opacity) !== undefined
      ? { opacity: Math.max(0, Math.min(1, shape.opacity!)) }
      : {}),
  };
}
