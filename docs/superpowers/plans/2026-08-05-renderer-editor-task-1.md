# Renderer Editor Task 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `@openmaic/renderer/editing` to the professional slide surface behind one default-off feature flag while preserving the legacy editor and existing undo/redo/autosave ownership.

**Architecture:** `SlideCanvas` chooses the legacy or renderer surface. A pure host adapter beside the slide surface folds one renderer `EditIntent[]` batch into one immutable `SlideContent` snapshot; `slide-edit-session` commits that snapshot as one user transaction and remains the only persistence/history owner.

**Tech Stack:** TypeScript, React 19, Zustand, Immer, Vitest, `@openmaic/renderer/editing`, existing slide edit operations.

## Global Constraints

- Use only `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`; do not add element-level flags.
- The flag defaults to disabled and the legacy canvas behavior remains unchanged.
- The renderer owns gestures and emits `EditIntent`; the app owns canonical content, selection, undo/redo, autosave, and editor chrome.
- Element-specific parity, inline text editing, context menus, and keyboard shortcuts remain outside Task 1.

---

### Task 1: Add the renderer editor feature flag

**Files:**
- Modify: `.env.example`
- Modify: `lib/config/feature-flags.ts`
- Test: `tests/config/feature-flags.test.ts`

**Interfaces:**
- Consumes: `readBoolean(envValue: string | undefined): boolean`
- Produces: `isEditorRendererEnabled(): boolean`

- [ ] **Step 1: Add failing feature flag tests**

```ts
describe('isEditorRendererEnabled', () => {
  const flag = 'NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED';

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isEditorRendererEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isEditorRendererEnabled()).toBe(true);
    process.env[flag] = '1';
    expect(isEditorRendererEnabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env[flag] = 'false';
    expect(isEditorRendererEnabled()).toBe(false);
    process.env[flag] = 'yes';
    expect(isEditorRendererEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the flag tests and verify the new import/export is missing**

Run: `corepack pnpm vitest run tests/config/feature-flags.test.ts`

Expected: FAIL because `isEditorRendererEnabled` is not exported.

- [ ] **Step 3: Add the minimal flag implementation and example**

```ts
export function isEditorRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED);
}
```

Add to `.env.example`:

```dotenv
# Use @openmaic/renderer/editing for the Pro-mode slide editor canvas. Default: false (legacy editor).
# NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED=false
```

- [ ] **Step 4: Run the flag tests**

Run: `corepack pnpm vitest run tests/config/feature-flags.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the feature flag**

```bash
git add .env.example lib/config/feature-flags.ts tests/config/feature-flags.test.ts
git commit -m "feat: gate renderer slide editor"
```

### Task 2: Extract and test the host EditIntent adapter

**Files:**
- Create: `components/edit/surfaces/slide/renderer-edit-intents.ts`
- Create: `tests/edit/surfaces/slide/renderer-edit-intents.test.ts`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`

**Interfaces:**
- Consumes: `EditIntent[]`, `SlideContent`, `applySlideEditOperation`
- Produces: `applyRendererEditIntents(content: SlideContent, intents: readonly EditIntent[]): SlideContent`

- [ ] **Step 1: Add failing adapter tests**

Create fixtures with three ordered elements and assert these cases:

```ts
expect(applyRendererEditIntents(content, [
  { type: 'element.update', id: 'a', props: { left: 40 } },
]).canvas.elements[0].left).toBe(40);

expect(applyRendererEditIntents(content, [
  { type: 'element.updateMany', updates: [
    { id: 'a', props: { top: 10 } },
    { id: 'b', props: { left: 20 } },
  ] },
]).canvas.elements.map(({ left, top }) => ({ left, top }))).toMatchObject([
  { top: 10 },
  { left: 20 },
  {},
]);

expect(applyRendererEditIntents(content, [
  { type: 'element.reorder', id: 'a', command: 'front' },
]).canvas.elements.map((element) => element.id)).toEqual(['b', 'c', 'a']);
```

Also assert add at index, delete-many animation cleanup, all four reorder commands, six align commands, property removal, text content, shape-label content, missing IDs as no-ops, and multiple intents applied in order.

- [ ] **Step 2: Run the adapter tests and verify the module is missing**

Run: `corepack pnpm vitest run tests/edit/surfaces/slide/renderer-edit-intents.test.ts`

Expected: FAIL because `renderer-edit-intents.ts` does not exist.

- [ ] **Step 3: Implement the pure adapter**

```ts
export function applyRendererEditIntents(
  content: SlideContent,
  intents: readonly EditIntent[],
): SlideContent {
  return intents.reduce((next, intent) => {
    switch (intent.type) {
      case 'element.update':
        return applySlideEditOperation(next, {
          type: 'element.update',
          elementId: intent.id,
          patch: intent.props,
        });
      case 'element.updateMany':
        return applyMixedUpdates(next, intent.updates);
      case 'element.add':
        return applySlideEditOperation(next, {
          type: 'element.add',
          element: intent.element,
          index: intent.index,
        });
      case 'element.delete':
        return applySlideEditOperation(next, {
          type: 'element.deleteMany',
          elementIds: [...intent.ids],
        });
      case 'element.reorder':
        return applyReorderIntent(next, intent);
      case 'element.align':
        return applySlideEditOperation(next, {
          type: 'element.align',
          elementIds: [...intent.ids],
          command: intent.command === 'center'
            ? 'horizontal'
            : intent.command === 'middle'
              ? 'vertical'
              : intent.command,
        });
      case 'element.removeProps':
        return applySlideEditOperation(next, {
          type: 'element.removeProps',
          elementId: intent.id,
          propNames: [...intent.props],
        });
      case 'text.updateContent':
        return applyTextContentIntent(next, intent);
      default:
        return assertNever(intent);
    }
  }, content);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported renderer edit intent: ${JSON.stringify(value)}`);
}
```

Move the existing reorder, mixed-update, and text/shape-content helpers out of `SlideCanvas.tsx` into this module. Keep them private.

- [ ] **Step 4: Run the adapter tests**

Run: `corepack pnpm vitest run tests/edit/surfaces/slide/renderer-edit-intents.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the adapter**

```bash
git add components/edit/surfaces/slide/renderer-edit-intents.ts tests/edit/surfaces/slide/renderer-edit-intents.test.ts components/edit/surfaces/slide/SlideCanvas.tsx
git commit -m "feat: adapt renderer editor intents"
```

### Task 3: Wire controlled selection and one-transaction commits

**Files:**
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Modify: `tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`
- Verify: `tests/edit/slide-edit-session.test.ts`

**Interfaces:**
- Consumes: `applyRendererEditIntents`, `useCanvasStore`, `useSlideEditSession`, `useResolvedSlide`
- Produces: feature-gated `RendererEditorCanvas` with controlled `Selection`

- [ ] **Step 1: Add failing component expectations**

Test that an active application selection is passed into the renderer:

```ts
expect(lastRendererProps?.selection).toEqual({
  elementIds: ['title-1'],
  primaryId: 'title-1',
});
```

Test that renderer selection changes call:

```ts
lastRendererProps?.onSelectionChange?.({
  elementIds: ['title-1'],
  primaryId: 'title-1',
});
expect(mockSetActiveElementIdList).toHaveBeenCalledWith(['title-1']);
```

Test that one intent batch produces exactly one user commit with the fully folded snapshot:

```ts
lastRendererProps?.onElementsChange?.([
  { type: 'element.update', id: 'title-1', props: { left: 48 } },
  { type: 'element.update', id: 'title-1', props: { top: 64 } },
]);
expect(mockCommitContent).toHaveBeenCalledTimes(1);
expect(mockCommitContent).toHaveBeenCalledWith(
  expect.objectContaining({
    canvas: expect.objectContaining({
      elements: [expect.objectContaining({ left: 48, top: 64 })],
    }),
  }),
  true,
);
```

Keep explicit checks that the legacy canvas is the only canvas mounted when the flag is unset or false, and the renderer canvas is the only canvas mounted when true.

- [ ] **Step 2: Run the component test and verify the new expectations fail**

Run: `corepack pnpm vitest run tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`

Expected: FAIL until controlled selection, adapter calls, and feature gating are wired.

- [ ] **Step 3: Implement the renderer host component**

```tsx
function RendererEditorCanvas() {
  const content = useResolvedSlideContent();
  const resolvedSlide = useResolvedSlide(content.canvas);
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();

  const selection = useMemo<Selection>(() => ({
    elementIds: activeElementIds,
    primaryId: activeElementIds[0],
  }), [activeElementIds]);

  const handleSelectionChange = useCallback((next: Selection) => {
    setActiveElementIdList([...next.elementIds]);
  }, [setActiveElementIdList]);

  const handleElementsChange = useCallback((intents: EditIntent[]) => {
    const next = applyRendererEditIntents(content, intents);
    useSlideEditSession.getState().commitContent(next, true);
  }, [content]);

  return <EditableSlideCanvas
    slide={resolvedSlide}
    selection={selection}
    onSelectionChange={handleSelectionChange}
    onElementsChange={handleElementsChange}
  />;
}
```

Use `isEditorRendererEnabled()` inside `SlideCanvas` to select `<RendererEditorCanvas />` or the unchanged legacy `<Canvas />`. Keep overlays, anchored bars, `ElementPickLayer`, `SceneProvider`, and gesture props outside the conditional.

- [ ] **Step 4: Run integration and session tests**

Run:

```bash
corepack pnpm vitest run \
  tests/config/feature-flags.test.ts \
  tests/edit/surfaces/slide/renderer-edit-intents.test.ts \
  tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts \
  tests/edit/slide-edit-session.test.ts
```

Expected: PASS. The session tests must continue proving one user commit creates one undo step, stage-store write-through occurs, and undo/redo write restored snapshots through.

- [ ] **Step 5: Run static verification**

Run:

```bash
corepack pnpm exec tsc --noEmit
corepack pnpm exec eslint \
  lib/config/feature-flags.ts \
  components/edit/surfaces/slide/renderer-edit-intents.ts \
  components/edit/surfaces/slide/SlideCanvas.tsx \
  tests/config/feature-flags.test.ts \
  tests/edit/surfaces/slide/renderer-edit-intents.test.ts \
  tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts
git diff --check
```

Expected: all commands exit successfully with no diagnostics.

- [ ] **Step 6: Commit the host integration**

```bash
git add components/edit/surfaces/slide/SlideCanvas.tsx tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts
git commit -m "feat: connect renderer editor to slide surface"
```
