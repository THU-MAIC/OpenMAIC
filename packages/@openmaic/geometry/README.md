# @openmaic/geometry

Pure, server/browser-compatible SVG path and shape geometry validation. No DOM or application dependencies; the DSL remains dependency-free.

```ts
import { validateSvgPath, validateShapeGeometry } from '@openmaic/geometry';
const result = validateShapeGeometry(shape, { maxLength: 100_000, maxCommands: 10_000, maxCoordinate: 1_000_000 });
if (!result.ok) console.warn(result.error); // code, field, message, optional UTF-16 position
```

Validation consumes the whole path, including implicit repetitions, scientific notation and adjacent arc flags. It requires an initial moveto and non-negative arc radii, using the SVG 1.1 grammar accepted by svg-pathdata. Empty, open and degenerate paths are valid. It does not change the stored path or verify mathematical relationships between shapes.

`bounds` is a conservative control-point box in path coordinates (curves and arcs included), or `null` for an empty path. Zero bounds are valid geometry, never a failure sentinel. Success also exposes parsed commands for exporters. Limits apply before parsing (length), during scanning (command count and raw values), after absolute conversion (coordinates), and after shape scaling. Shape width, height and both viewBox entries must be finite and positive. Arcs are computed in local unit coordinates to avoid the parser's absolute-radius epsilon. An arc whose axis ratio is below `1e-10`, or whose computation loses non-degenerate geometry, returns an explicit numerical error.

Use `INPUT_PATH_LIMITS` for new generated/edited geometry. `RENDER_PATH_LIMITS` is a separate, larger rendering budget for historical/imported content. Neither belongs in document loading, migration, replay, undo or redo. A path exceeding the rendering budget can be skipped locally without deleting its stored data or label. `shapeGeometryChanged` lets callers validate writes without revalidating unrelated historical shapes.

Failed user edits should retain the prior snapshot and report the structured error. Generated failures and historical rendering use the same `shapeToTextFallback` projection. New generation persists the recovered text; historical rendering uses BaseTextElement without rewriting its original record. Empty/missing labels return null. The projection preserves text alignment/spacing, rotation, opacity and common metadata, bounds invalid sizes to a finite text viewport (100 fallback, 4000 maximum), and chooses a solid backdrop with readable default text contrast. Inline HTML colors remain author-controlled; gradient/pattern/shape geometry and effects are not reproduced. Do not truncate a path, silently keep a valid prefix, or substitute a rectangle for meaningful diagram geometry.
