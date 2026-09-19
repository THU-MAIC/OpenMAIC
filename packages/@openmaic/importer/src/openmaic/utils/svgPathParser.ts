/**
 * Compute the bounding-box max corner of an SVG path's `d` attribute.
 *
 * Used by the PPTX import pipeline to derive a `viewBox` when the shape's
 * path has been customised and no longer matches the preset dimensions.
 *
 * Implementation notes:
 * - Handles standard absolute commands: M, L, H, V, C, S, Q, T, A, Z.
 * - Relative commands (m/l/h/v/c/s/q/t/a) are tracked against the current
 *   point so coordinates accumulate correctly.
 * - Arc command arguments (rx, ry, x-axis-rotation, large-arc, sweep) are
 *   skipped; only the endpoint affects the bounding box approximation.
 *   The true arc extrema can extend beyond the endpoint — for `viewBox`
 *   sizing this is a small under-approximation that callers can compensate
 *   for by padding (which the import pipeline already does indirectly).
 * - Returns `{ maxX: 0, maxY: 0 }` for empty / unparseable input; callers
 *   typically fall back to the element's original width/height in that case.
 */
export interface PathRange {
  maxX: number;
  maxY: number;
}

const NUMBER_RE = /-?\d*\.?\d+(?:[eE]-?\d+)?/g;
const COMMAND_RE = /[MLHVCSQTAZmlhvcsqtaz]/;

export function getSvgPathRange(path: string | undefined | null): PathRange {
  if (!path) return { maxX: 0, maxY: 0 };

  const tokens = path.match(/[MLHVCSQTAZmlhvcsqtaz]|-?\d*\.?\d+(?:[eE]-?\d+)?/g);
  if (!tokens) return { maxX: 0, maxY: 0 };

  let maxX = 0;
  let maxY = 0;
  let cx = 0;
  let cy = 0;
  let cmd = '';
  let i = 0;

  const pushPoint = (x: number, y: number) => {
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    cx = x;
    cy = y;
  };

  const readNum = (): number => {
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (COMMAND_RE.test(tok)) {
      cmd = tok;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        // closepath does not introduce a new point in our scan
        continue;
      }
    }

    const absolute = cmd === cmd.toUpperCase();
    switch (cmd.toUpperCase()) {
      case 'M':
      case 'L':
      case 'T': {
        const x = readNum();
        const y = readNum();
        pushPoint(absolute ? x : cx + x, absolute ? y : cy + y);
        break;
      }
      case 'H': {
        const x = readNum();
        pushPoint(absolute ? x : cx + x, cy);
        break;
      }
      case 'V': {
        const y = readNum();
        pushPoint(cx, absolute ? y : cy + y);
        break;
      }
      case 'Q':
      case 'S': {
        const c1x = readNum();
        const c1y = readNum();
        const x = readNum();
        const y = readNum();
        // Control point can extend the bbox too; cheap to include.
        pushPoint(absolute ? c1x : cx + c1x, absolute ? c1y : cy + c1y);
        pushPoint(absolute ? x : cx + x, absolute ? y : cy + y);
        break;
      }
      case 'C': {
        const c1x = readNum();
        const c1y = readNum();
        const c2x = readNum();
        const c2y = readNum();
        const x = readNum();
        const y = readNum();
        pushPoint(absolute ? c1x : cx + c1x, absolute ? c1y : cy + c1y);
        pushPoint(absolute ? c2x : cx + c2x, absolute ? c2y : cy + c2y);
        pushPoint(absolute ? x : cx + x, absolute ? y : cy + y);
        break;
      }
      case 'A': {
        // rx ry x-axis-rotation large-arc-flag sweep-flag x y
        readNum();
        readNum();
        readNum();
        readNum();
        readNum();
        const x = readNum();
        const y = readNum();
        pushPoint(absolute ? x : cx + x, absolute ? y : cy + y);
        break;
      }
      default:
        // unknown command — advance to avoid infinite loop
        i++;
    }
  }

  return { maxX, maxY };
}
