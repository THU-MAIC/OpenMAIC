# Renderer Audio Editing Design

## Goal

Add complete Audio element support to the renderer editor while keeping every
interactive surface in `@openmaic/renderer/editing-ui`. The renderer must show
an Audio element on the slide and support its normal canvas lifecycle; the App
host must only bridge DSL persistence, undo/redo, and autosave.

The work remains behind `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`. The legacy
editor path is not changed.

## Scope

The first delivery supports:

- Rendering `PPTAudioElement` as an accessible, compact audio card on the
  canvas.
- Selection, move, resize, delete, z-order, and lock/group behaviour through
  the existing renderer editing core.
- No rotate handle, matching the existing audio geometry policy.
- A renderer-owned insert picker for local audio files and audio URLs.
- A renderer-owned selected-element toolbar for preview/play-pause, loop,
  z-order, and deletion.
- Editor previews never autoplay, even when a persisted source document has
  `autoplay: true`.

It does not create audio assets on a server, edit waveform data, change
timeline narration (`Action.audioId`), or add an App-owned picker/player.

## Architecture

### Rendering

`SlideElement` gains an `AUDIO` branch that renders `BaseAudioElement`. The
base element owns only the stable visual card and its audio metadata. It does
not import editing state or App code.

The card uses a speaker icon, a filename derived from `src`, and a compact
duration/playback indicator. It has a fixed visual minimum but follows the
element's stored `left`, `top`, `width`, `height`, and `rotate` data. Native
audio controls are not rendered on the canvas, so they cannot capture editing
gestures.

### Editing UI

`editing-ui/audio` mirrors the video package structure:

1. `AudioInsertPicker` accepts browser file selection, drag/drop, and URLs;
   it reads local files to data URLs and reports `{ src, ext }`.
2. `AudioToolbarOverlay` anchors to the selected Audio element and owns its
   preview state. It renders preview/play-pause, loop, bring-to-front,
   send-to-back, and delete controls with renderer tooltips.
3. `EditableSlideCanvasWithUI` adds optional `audioEditor` and `audioInsert`
   configuration. It adds the audio insert action to the renderer-owned insert
   toolbar and only exposes the selected audio toolbar for one unlocked Audio
   element.

The preview is an in-memory browser `Audio` instance owned by the toolbar. It
is paused when selection changes, the toolbar unmounts, or the user stops
preview. It never writes playback state into the slide document.

## Host Bridge

The App passes labels and callback functions only:

- `onInsert(result)` creates the audio element id, supplies its default box,
  persists `src`, `ext`, `loop: false`, and `autoplay: false`, and records one
  `element.add` history item.
- `onLoopChange(id, loop)` emits one `element.update` intent.
- `onBringToFront`, `onSendToBack`, and `onDelete` map to existing generic
  element intents.

The App does not render an audio picker, preview control, or toolbar. The DSL
retains `autoplay` for compatibility with existing data, but renderer editing
does not expose it as a user setting.

## Behaviour And Error Handling

- File selection accepts only `audio/*`; invalid drops leave the picker open.
- URL insertion requires a nonempty source and infers `ext` when available.
- Preview failures return the play control to its idle state without changing
  element data.
- Elements with missing or unreadable sources render a neutral unavailable
  card and remain selectable/deletable.
- The insert picker and toolbar use only renderer editing UI classes and
  translated labels passed by the host.

## Verification

- Unit tests for Audio visual fallback, URL/file picker results, preview state
  cleanup, loop toggling, and selected toolbar actions.
- Integration tests for `EditableSlideCanvasWithUI` insertion and selected
  audio controls.
- Host tests proving one history record for insert/loop and inert editor
  preview behaviour.
- Regression tests for feature flag off and existing Video behaviour.
- Renderer build/typecheck plus manual browser checks for insert, selection,
  move, resize, preview, loop, delete, undo/redo, and legacy fallback.
