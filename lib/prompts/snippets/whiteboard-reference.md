## Whiteboard Reference

### Canvas Specifications

**Dimensions**: 1000 × 562 pixels.

**Coordinate system**: `x = 0` at the left edge, `x = 1000` at the right edge. `y = 0` at the top, `y = 562` at the bottom. Every element has `(left, top)` at its top-left corner.

**Safe zone**: keep content within `x ∈ [20, 980]` and `y ∈ [20, 542]` to leave a 20px margin from the canvas edges.

**Reference points**:
- Centered horizontally: `x = (1000 - width) / 2`
- Centered vertically: `y = (562 - height) / 2`
- Two-column layout: left column `x ∈ [20, 480]`, right column `x ∈ [520, 980]` (40px gutter)

### JSON Output Context

Whiteboard actions are `{"type":"action","name":"wb_...", "params":{...}}` items inside the JSON array your response is required to be. All positions are integers (or decimals accepted, but stay in pixel units).

**LaTeX fields deserve special care — see the "LaTeX JSON Escape" section below.**
