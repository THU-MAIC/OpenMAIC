# Renderer Latex Editor Design

## Goal

Add a Latex insert action to the renderer editing UI and use one renderer-owned
editor dialog for both creating and modifying a formula. The interaction follows
PPTist's model: source input, live preview, a common-symbol palette, a preset
formula palette, and explicit confirm/cancel actions.

The renderer editor remains behind `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`.
The legacy editor continues to use its existing path unchanged.

## Scope

The dialog creates or updates a `PPTLatexElement` with:

- `latex`: the source entered by the user.
- `html`: KaTeX HTML generated from that source.
- `width` and `height`: the measured formula box with a fixed padding margin.
- Existing `color` and `align` values are retained while editing an element.

The first delivery includes source editing, KaTeX preview, common symbols, and
preset formulas. It does not add visual WYSIWYG math-field editing, SVG-path
generation, or a separate legacy-editor implementation.

## Architecture

`@openmaic/renderer/editing-ui` owns UI state and components:

1. `LatexEditorDialog` accepts an optional initial Latex payload and emits a
   validated result on confirmation.
2. `LatexEditorPanel` contains the source textarea, preview, symbol palette,
   and formula-preset palette. Symbol selection inserts text at the textarea
   selection rather than replacing the entire source.
3. `LatexEditorOverlay` determines whether the dialog is creating or editing.
   It is opened from the insert toolbar or from the selected Latex element's
   floating toolbar.

The package creates neither DSL ids nor application history. Its public props
use callbacks only:

- `onInsert(result)` for a confirmed new formula.
- `onUpdate(elementId, result)` for a confirmed existing formula.
- `onClose()` for cancel/complete.

The App host remains responsible for constructing ids and applying the result
through `EditIntent` and `slide-edit-session`. This keeps the package free of
App imports and makes the whole confirmation one undo/redo/autosave record.

## Data Flow

1. User presses the Latex insert icon; the host opens the shared dialog in
   create mode.
2. The dialog uses KaTeX `renderToString` for the preview and for the committed
   `html` value. Invalid input leaves the current valid preview intact and
   exposes an inline error; confirm is disabled while invalid or empty.
3. On confirm in create mode, the App host creates a `PPTLatexElement` at a
   default canvas location and emits one `element.add` intent.
4. When a single unlocked Latex element is selected, renderer editing UI shows
   an edit-formula action. Opening it passes the element's source, color, and
   alignment to the same dialog.
5. On confirm in edit mode, the App host emits one `element.update` intent with
   the source, rendered HTML, and measured dimensions. It preserves the
   element's position, rotation, color, and alignment.
6. `SlideCanvas` applies the intent and calls `commitContent(next, true)`.

## Layout And Accessibility

The dialog has a stable desktop layout similar to PPTist:

- Left: source textarea over a live formula preview.
- Right: tabs for common symbols and preset formulas.
- Footer: cancel and confirm buttons.

It uses renderer editing UI classes, keyboard focus management, descriptive
button labels/tooltips, `Escape` cancellation, and `aria-live` for Latex parse
errors. On narrow viewports it stacks source/preview above the palettes.

## Tests

Focused tests cover:

- KaTeX conversion, invalid syntax, and measurement/default-size handling.
- Symbol insertion at the current textarea selection and preset replacement.
- Insert toolbar opening the dialog and emitting one element-add intent.
- Selected Latex opening the same dialog and emitting one update intent.
- App host commits both paths with `history=true`.
- Feature flag disabled still renders the legacy editor.

Verification includes renderer tests and build, root TypeScript checking, root
test suite, and a manual browser checklist covering insert, edit, cancel,
invalid syntax, undo/redo, and feature-flag fallback.
