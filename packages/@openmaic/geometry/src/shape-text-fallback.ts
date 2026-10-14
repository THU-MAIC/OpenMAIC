import type { PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import tinycolor from 'tinycolor2';

/** One bounded text projection for generated and historical invalid shapes. */
export function shapeToTextFallback(shape: PPTShapeElement): PPTTextElement | null {
  const label = shape.text;
  if (!label || typeof label.content !== 'string') return null;
  const plain = label.content
    .replace(/\x3c!--[\s\S]*?-->|<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ')
    .trim();
  if (!plain && !/data-inline-math|<math\b|<img\b/i.test(label.content)) return null;

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
      ? { link: { ...shape.link } }
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
    ...(finite(label.lineHeight) !== undefined ? { lineHeight: label.lineHeight } : {}),
    ...(finite(label.wordSpace) !== undefined ? { wordSpace: label.wordSpace } : {}),
    paragraphSpace: finite(label.paragraphSpace) ?? 5,
    ...(label.type !== undefined ? { textType: label.type } : {}),
    ...(finite(shape.opacity) !== undefined
      ? { opacity: Math.max(0, Math.min(1, shape.opacity!)) }
      : {}),
  };
}
