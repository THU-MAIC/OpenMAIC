import { SVGPathData, SVGPathDataTransformer } from 'svg-pathdata';
import type { PPTShapeElement } from '@openmaic/dsl';
export { shapeToTextFallback } from './shape-text-fallback.js';

export interface PathLimits {
  /** UTF-16 code units, checked before tokenization or parsing. */
  maxLength: number;
  /** Includes implicit repeated parameter groups and close-path commands. */
  maxCommands: number;
  /** Applies to input, resolved coordinates, and scaled drawing coordinates. */
  maxCoordinate: number;
}

export const INPUT_PATH_LIMITS: Readonly<PathLimits> = Object.freeze({
  maxLength: 100_000,
  maxCommands: 10_000,
  maxCoordinate: 1_000_000,
});

/** Rendering budget only: never apply these limits while loading a document. */
export const RENDER_PATH_LIMITS: Readonly<PathLimits> = Object.freeze({
  maxLength: 2_000_000,
  maxCommands: 200_000,
  maxCoordinate: 1e12,
});

export interface GeometryError {
  code: 'syntax' | 'non_finite' | 'invalid_dimension' | 'resource_limit';
  field: string;
  message: string;
  /** Zero-based UTF-16 offset in the original path, where available. */
  position?: number;
}

export interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type PathValidation =
  | { ok: true; commands: SVGPathData['commands']; bounds: PathBounds | null }
  | { ok: false; error: GeometryError };

const ARG_COUNTS: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};
const NUMBER = /[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/y;
const whitespace = (c: string | undefined) => c !== undefined && /[ \t\r\n\f]/.test(c);

function fail(
  code: GeometryError['code'],
  field: string,
  message: string,
  position?: number,
): PathValidation {
  return {
    ok: false,
    error: { code, field, message, ...(position === undefined ? {} : { position }) },
  };
}

function numericError(value: number, limit: number): GeometryError['code'] | null {
  if (!Number.isFinite(value)) return 'non_finite';
  return Math.abs(value) > limit ? 'resource_limit' : null;
}

class GeometryComputationError extends Error {
  constructor(
    readonly code: GeometryError['code'],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate the complete SVG path grammar before delegating geometry to svg-pathdata.
 * The library alone accepts numbers after Z, Infinity, and missing arc separators.
 * No browser, logger, DOM, exporter, or document mutation is involved.
 */
export function validateSvgPath(path: unknown, policy: Partial<PathLimits> = {}): PathValidation {
  const limits = { ...INPUT_PATH_LIMITS, ...policy };
  if (typeof path !== 'string') return fail('syntax', 'path', 'Expected an SVG path string');
  if (path.length > limits.maxLength)
    return fail('resource_limit', 'path', `Path exceeds ${limits.maxLength} code units`);

  let i = 0;
  let count = 0;
  let command = '';
  const segments: string[] = [];
  const skipWhitespace = () => {
    while (whitespace(path[i])) i++;
  };
  skipWhitespace();
  if (i < path.length && !/[Mm]/.test(path[i]))
    return fail('syntax', 'path', 'Path must begin with moveto (M or m)', i);

  while (i < path.length) {
    let explicit = false;
    if (Object.hasOwn(ARG_COUNTS, path[i].toUpperCase())) {
      command = path[i++];
      explicit = true;
    } else if (!command || command.toUpperCase() === 'Z') {
      return fail('syntax', 'path', 'Expected a path command; numbers cannot follow closepath', i);
    }
    if (++count > limits.maxCommands)
      return fail('resource_limit', 'path', `Path exceeds ${limits.maxCommands} commands`, i);
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      segments.push(command);
      skipWhitespace();
      continue;
    }
    const args: string[] = [];
    for (let arg = 0; arg < ARG_COUNTS[upper]; arg++) {
      const before = i;
      skipWhitespace();
      let separated = i > before;
      if (path[i] === ',') {
        if (explicit && arg === 0)
          return fail('syntax', 'path', 'Comma cannot follow a command', i);
        i++;
        skipWhitespace();
        separated = true;
      }
      const flag = upper === 'A' && (arg === 3 || arg === 4);
      if (i === path.length)
        return fail(
          'syntax',
          'path',
          flag ? 'Arc flag must be 0 or 1' : `Expected parameter ${arg + 1} of ${command}`,
          i,
        );
      // Signs and a second decimal point terminate the preceding number. Arc
      // flags are single digits and may be adjacent to each other and to x.
      const previousWasFlag = upper === 'A' && (arg === 4 || arg === 5);
      if (
        !separated &&
        !(explicit && arg === 0) &&
        !previousWasFlag &&
        i > 0 &&
        !/[+\-.]/.test(path[i] ?? '')
      ) {
        return fail('syntax', 'path', 'Expected a separator between numbers', i);
      }
      NUMBER.lastIndex = i;
      const token = flag
        ? /[01]/.test(path[i] ?? '') && path[i] !== undefined
          ? path[i]
          : null
        : NUMBER.exec(path)?.[0];
      if (!token)
        return fail(
          'syntax',
          'path',
          flag ? 'Arc flag must be 0 or 1' : `Expected parameter ${arg + 1} of ${command}`,
          i,
        );
      const value = Number(token);
      const error = numericError(value, limits.maxCoordinate);
      if (error)
        return fail(
          error,
          'path',
          error === 'non_finite'
            ? 'Path number must be finite'
            : `Path number exceeds ${limits.maxCoordinate}`,
          i,
        );
      if (upper === 'A' && arg < 2 && value < 0)
        return fail('syntax', 'path', 'Arc radius must be non-negative', i);
      args.push(String(value));
      i += token.length;
    }
    // Explicit separators also avoid svg-pathdata's special treatment of 00.
    segments.push(`${command} ${args.join(' ')}`);
    if (upper === 'M') command = command === 'm' ? 'l' : 'L';
    // Leave separators for implicit repetitions to the next iteration.
    const end = i;
    skipWhitespace();
    if (i === path.length || Object.hasOwn(ARG_COUNTS, path[i].toUpperCase())) continue;
    i = end;
  }

  try {
    const parsed = new SVGPathData(segments.join(' '));
    let previousX = 0,
      previousY = 0;
    const absolute = new SVGPathData(parsed.commands.map((c) => ({ ...c })))
      .toAbs()
      // svg-pathdata turns zero-radius arcs into lines here, before arcControlPoints.
      .transform(SVGPathDataTransformer.NORMALIZE_HVZ(true, true, true, false))
      .normalizeST()
      .qtToC()
      .transform((c) => {
        // Equal arc endpoints draw nothing (SVG2 F.6); a2c would divide by zero.
        const command =
          c.type === SVGPathData.ARC
            ? arcControlPoints(c, previousX, previousY, limits.maxCoordinate)
            : c;
        if ('x' in c) previousX = c.x;
        if ('y' in c) previousY = c.y;
        return command;
      });
    let bounds: PathBounds | null = null;
    for (const c of absolute.commands) {
      for (const [key, value] of Object.entries(c)) {
        if (key === 'type' || typeof value !== 'number') continue;
        const error = numericError(value, limits.maxCoordinate);
        if (error) return fail(error, 'path', 'Resolved path geometry exceeds numeric limits');
      }
      for (const [xKey, yKey] of [
        ['x', 'y'],
        ['x1', 'y1'],
        ['x2', 'y2'],
      ] as const) {
        const point = c as unknown as Record<string, unknown>;
        const x = point[xKey],
          y = point[yKey];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        if (!bounds) bounds = { minX: x, maxX: x, minY: y, maxY: y };
        else {
          bounds.minX = Math.min(bounds.minX, x);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxY = Math.max(bounds.maxY, y);
        }
      }
    }
    // A null/zero-sized bbox is legitimate for an empty/moveto/degenerate path.
    return { ok: true, commands: parsed.commands, bounds };
  } catch (error) {
    return fail(
      error instanceof GeometryComputationError ? error.code : 'non_finite',
      'path',
      error instanceof Error ? error.message : 'Path geometry computation failed',
    );
  }
}

/**
 * Normalize each arc in local unit coordinates before using the library. Its
 * absolute 1e-10 radius epsilon would otherwise turn valid tiny arcs into lines;
 * unscaled radius squares can also overflow. The stored command stays unchanged.
 */
function arcControlPoints(
  arc: Extract<SVGPathData['commands'][number], { type: typeof SVGPathData.ARC }>,
  x: number,
  y: number,
  limit: number,
): SVGPathData['commands'] {
  if (arc.x === x && arc.y === y) return [{ type: SVGPathData.LINE_TO, relative: false, x, y }];
  const theta = ((arc.xRot % 360) * Math.PI) / 180;
  const dx = x / 2 - arc.x / 2,
    dy = y / 2 - arc.y / 2;
  const chordX = Math.cos(theta) * dx + Math.sin(theta) * dy;
  const chordY = -Math.sin(theta) * dx + Math.cos(theta) * dy;
  const radius = Math.max(arc.rX, arc.rY);
  const rx = arc.rX / radius,
    ry = arc.rY / radius;
  // SVG endpoint-to-center radius correction, with no squared tiny/huge radii.
  const corrected = Math.max(radius, Math.hypot(chordX / rx, chordY / ry));
  if (![corrected, corrected * rx, corrected * ry].every(Number.isFinite))
    throw new Error('Arc radius correction overflowed');
  if (corrected > limit)
    throw new GeometryComputationError(
      'resource_limit',
      'Corrected arc radius exceeds numeric limits',
    );
  // An extreme aspect ratio falls below the dependency's precision. Reject it
  // explicitly instead of silently deriving the bounds of a different path.
  if (rx < 1e-10 || ry < 1e-10)
    throw new Error('Arc aspect ratio exceeds supported numerical precision');
  const local = new SVGPathData([
    { type: SVGPathData.MOVE_TO, relative: false, x: 0, y: 0 },
    {
      ...arc,
      rX: rx,
      rY: ry,
      xRot: arc.xRot % 360,
      x: (arc.x - x) / corrected,
      y: (arc.y - y) / corrected,
    },
  ]).aToC();
  if (local.commands.length < 2)
    throw new Error('Arc conversion lost non-degenerate geometry at numerical precision limits');
  return local.commands.slice(1).map((command) => {
    const values = { ...command } as unknown as Record<string, unknown>;
    for (const key of ['x', 'x1', 'x2'])
      if (typeof values[key] === 'number') values[key] = values[key] * corrected + x;
    for (const key of ['y', 'y1', 'y2'])
      if (typeof values[key] === 'number') values[key] = values[key] * corrected + y;
    return values as unknown as SVGPathData['commands'][number];
  });
}

export function validateShapeGeometry(
  shape: Pick<PPTShapeElement, 'path' | 'viewBox' | 'width' | 'height'>,
  policy: Partial<PathLimits> = {},
): PathValidation {
  const limit = policy.maxCoordinate ?? INPUT_PATH_LIMITS.maxCoordinate;
  if (!Array.isArray(shape.viewBox) || shape.viewBox.length !== 2)
    return fail('invalid_dimension', 'viewBox', 'Expected two positive viewBox dimensions');
  for (const [field, value] of [
    ['viewBox[0]', shape.viewBox[0]],
    ['viewBox[1]', shape.viewBox[1]],
    ['width', shape.width],
    ['height', shape.height],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      return fail('invalid_dimension', field, 'Dimension must be finite and positive');
    if (value > limit) return fail('resource_limit', field, `Dimension exceeds ${limit}`);
  }
  const sx = shape.width / shape.viewBox[0],
    sy = shape.height / shape.viewBox[1];
  if (!Number.isFinite(sx) || !Number.isFinite(sy))
    return fail('non_finite', 'viewBox', 'Scaling must be finite');
  const result = validateSvgPath(shape.path, policy);
  if (!result.ok || !result.bounds) return result;
  for (const value of [
    result.bounds.minX * sx,
    result.bounds.maxX * sx,
    result.bounds.minY * sy,
    result.bounds.maxY * sy,
  ]) {
    const error = numericError(value, limit);
    if (error) return fail(error, 'viewBox', 'Scaled path geometry exceeds numeric limits');
  }
  return result;
}

/** Validate only changed geometry so unrelated edits of historical shapes work. */
export function shapeGeometryChanged(before: PPTShapeElement, after: PPTShapeElement): boolean {
  const viewBoxChanged =
    Array.isArray(before.viewBox) && Array.isArray(after.viewBox)
      ? before.viewBox.length !== after.viewBox.length ||
        before.viewBox.some((value, index) => !Object.is(value, after.viewBox[index]))
      : !Object.is(before.viewBox, after.viewBox);
  return (
    before.path !== after.path ||
    !Object.is(before.width, after.width) ||
    !Object.is(before.height, after.height) ||
    viewBoxChanged
  );
}
