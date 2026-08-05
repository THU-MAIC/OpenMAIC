# Renderer Editor Task 1 Design

## Context

Professional-mode slide editing currently uses the legacy editor canvas. The
renderer package already exposes `EditableSlideCanvas`, but the application
must own feature gating, selection state, edit history, persistence, and the
fallback path. This task establishes that host integration in upstream
`THU-MAIC/OpenMAIC`; element-specific parity remains follow-up work.

## Scope

- Add one public feature flag: `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`.
- Render `EditableSlideCanvas` when the flag is enabled and the legacy `Canvas`
  when it is disabled or unset.
- Keep `useCanvasStore.activeElementIdList` as the application selection source
  of truth and synchronize renderer selection changes back to it.
- Translate renderer `EditIntent` batches into immutable `SlideContent`
  snapshots through a host-owned adapter.
- Commit each renderer intent batch once through `slide-edit-session`, so the
  existing undo/redo history and stage-store autosave remain authoritative.
- Preserve the existing overlays, anchored toolbars, timeline picker, and scene
  context around either canvas implementation.

## Boundaries

The renderer package owns pointer gestures and emits edit intents. The app owns
the canonical slide, selection store, transaction history, persistence, and
product-level chrome. The adapter belongs beside the slide surface rather than
inside `@openmaic/renderer`, because it depends on app-specific slide operations
and session semantics.

Only one renderer-editor flag is introduced. The legacy editor remains intact
and receives no behavioral changes. Text inline editing, element parity,
locked/grouped interaction parity, right-click menus, and keyboard shortcuts
are handled by later tasks.

## Data Flow

1. `SlideCanvas` reads the feature flag.
2. With the flag off, it renders the legacy canvas unchanged.
3. With the flag on, it resolves the current slide and passes controlled
   selection to `EditableSlideCanvas`.
4. Renderer selection events update `activeElementIdList`.
5. Renderer edit events are converted by the adapter from the current canonical
   content into one next snapshot.
6. `slide-edit-session.commitContent(next, true)` records one undo step and
   writes the snapshot to the stage store, which provides autosave.

## Intent Handling

The adapter supports the renderer vocabulary required by the current editing
surface: single and multi-element updates, add, delete, reorder, align, property
removal, and text-content updates. Unknown future intent variants must fail at
compile time when the union is extended, rather than being silently ignored.
Missing target element IDs are treated as no-ops by the canonical slide
operations.

## Verification

- Unit-test every supported intent mapping, including batching and no-op cases.
- Component-test feature flag off/unset and on behavior.
- Component-test controlled selection in both directions.
- Verify one renderer event produces one user commit.
- Reuse the existing `slide-edit-session` tests to prove that user commits,
  undo, redo, and stage-store write-through stay in sync.
- Run focused tests, TypeScript, and lint for all touched files.

## Acceptance Criteria

- Flag disabled or unset: only the legacy editor canvas is mounted.
- Flag enabled: only `EditableSlideCanvas` is mounted.
- Renderer selection is reflected in the app selection store.
- Every supported renderer intent produces the expected canonical slide state.
- One intent batch creates one undoable, auto-persisted edit.
- Existing overlays and editor chrome remain mounted in both paths.
