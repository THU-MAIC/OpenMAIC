# Renderer Latex Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one renderer-owned PPTist-style Latex dialog that is used to insert a formula and to edit an existing Latex element.

**Architecture:** `@openmaic/renderer/editing-ui` owns Latex source state, KaTeX conversion, preview, symbol/preset palettes, dialog layout, and the selected-element edit control. The App host supplies labels and callbacks, then translates confirmed results into one `element.add` or `element.update` intent and commits through the existing slide edit session.

**Tech Stack:** React 19, TypeScript, KaTeX 0.16, Vitest, Testing Library, Lucide, existing renderer editing-ui CSS.

## Global Constraints

- Keep all renderer UI and KaTeX conversion in `@openmaic/renderer/editing-ui`; do not import App aliases from that package.
- Preserve the `PPTLatexElement` HTML contract: `latex`, KaTeX `html`, geometry, `color`, and `align`.
- Confirming one dialog must emit exactly one host intent batch and one history record; typing and preview changes never commit.
- Keep `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED=false` on the existing legacy editor path.
- Use existing icon buttons, title tooltips, visible text only where a dialog command needs it, and responsive non-overlapping dialog layout.
- Update every file in `lib/i18n/locales/` with the same new keys and run `pnpm check:i18n-keys`.

---

## File Structure

- `packages/@openmaic/renderer/src/editing-ui/latex/latex-editor.ts`: pure KaTeX conversion, validation, textarea insertion, and result types.
- `packages/@openmaic/renderer/src/editing-ui/latex/latex-presets.ts`: renderer-owned common symbols and named preset formulas.
- `packages/@openmaic/renderer/src/editing-ui/latex/LatexEditorDialog.tsx`: modal editor, preview, tabs, and confirm/cancel behavior.
- `packages/@openmaic/renderer/src/editing-ui/latex/LatexToolbarOverlay.tsx`: selection-anchored edit-formula trigger.
- `packages/@openmaic/renderer/src/editing-ui/EditableSlideCanvasWithUI.tsx`: composes the insert trigger, selected Latex trigger, and shared dialog state.
- `packages/@openmaic/renderer/src/editing-ui/types.ts`: public Latex editor options and localized labels.
- `packages/@openmaic/renderer/src/editing-ui/index.ts`: public exports for the Latex editor result and options.
- `packages/@openmaic/renderer/src/editing-ui/styles.ts`: dialog, palette, preview, and responsive CSS.
- `components/edit/surfaces/slide/SlideCanvas.tsx`: App callbacks that create/update DSL Latex elements with the existing intent/history host.
- `lib/edit/slide-edit-elements.ts`: factory for a newly inserted Latex element from a renderer result.
- `lib/i18n/locales/*.json`: translated App labels passed into `latexEditor`.
- Tests under `packages/@openmaic/renderer/test/editing-ui/` and `tests/edit/surfaces/slide/`.

### Task 1: Define the Package Latex Contract and Pure Helpers

**Files:**
- Create: `packages/@openmaic/renderer/src/editing-ui/latex/latex-editor.ts`
- Create: `packages/@openmaic/renderer/src/editing-ui/latex/latex-presets.ts`
- Create: `packages/@openmaic/renderer/test/editing-ui/latex-editor.test.ts`
- Modify: `packages/@openmaic/renderer/src/editing-ui/types.ts`
- Modify: `packages/@openmaic/renderer/src/editing-ui/index.ts`

**Interfaces:**
- Produces `LatexEditorResult { latex: string; html: string; width: number; height: number }`.
- Produces `renderLatexSource(source: string): { html: string } | { error: string }`.
- Produces `insertLatexAtSelection(source, selectionStart, selectionEnd, symbol)`.
- Consumes the package `katex` dependency and no App modules.

- [ ] **Step 1: Write failing pure-helper tests**

```tsx
it('creates display-mode KaTeX HTML from valid source', () => {
  expect(renderLatexSource('x^2')).toMatchObject({ html: expect.stringContaining('katex') });
});

it('reports a parse error instead of committing invalid source', () => {
  expect(renderLatexSource('\\\\frac{')).toMatchObject({ error: expect.any(String) });
});

it('inserts a symbol at the current textarea selection', () => {
  expect(insertLatexAtSelection('a+b', 1, 2, '\\times')).toEqual({ value: 'a\\timesb', cursor: 7 });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/latex-editor.test.ts`

Expected: FAIL because the helper module and exports do not exist.

- [ ] **Step 3: Implement the minimal pure API and data**

```ts
export interface LatexEditorResult {
  readonly latex: string;
  readonly html: string;
  readonly width: number;
  readonly height: number;
}

export function renderLatexSource(source: string): { html: string } | { error: string } {
  try {
    return { html: katex.renderToString(source, { displayMode: true, output: 'html', throwOnError: true }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid LaTex' };
  }
}
```

Add a compact `LATEX_SYMBOL_GROUPS` and `LATEX_PRESETS` set covering arithmetic,
fractions/roots, Greek letters, integrals, matrices, and common formulas. Export
`LatexEditorOptions` with `labels`, `onInsert`, and `onUpdate` callback types.

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/latex-editor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated package contract**

```bash
git add packages/@openmaic/renderer/src/editing-ui/latex/latex-editor.ts \
  packages/@openmaic/renderer/src/editing-ui/latex/latex-presets.ts \
  packages/@openmaic/renderer/src/editing-ui/types.ts \
  packages/@openmaic/renderer/src/editing-ui/index.ts \
  packages/@openmaic/renderer/test/editing-ui/latex-editor.test.ts
git commit -m "feat(renderer): add latex editor contract"
```

### Task 2: Build the Shared PPTist-Style Latex Dialog

**Files:**
- Create: `packages/@openmaic/renderer/src/editing-ui/latex/LatexEditorDialog.tsx`
- Modify: `packages/@openmaic/renderer/src/editing-ui/styles.ts`
- Modify: `packages/@openmaic/renderer/src/editing-ui/index.ts`
- Create: `packages/@openmaic/renderer/test/editing-ui/LatexEditorDialog.test.tsx`

**Interfaces:**
- Consumes `LatexEditorResult`, `renderLatexSource`, `LATEX_SYMBOL_GROUPS`, and `LATEX_PRESETS` from Task 1.
- Produces `<LatexEditorDialog initialLatex onConfirm onClose labels />`.
- `onConfirm(result)` receives KaTeX HTML plus width/height measured from the preview content and 32px total padding, with a 120px x 48px lower bound.

- [ ] **Step 1: Write failing dialog tests**

```tsx
it('previews valid source and confirms a measured LatexEditorResult', async () => {
  render(<LatexEditorDialog initialLatex="x^2" onConfirm={onConfirm} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ latex: 'x^2', html: expect.stringContaining('katex') }));
});

it('inserts a palette symbol at the textarea caret', () => {
  render(<LatexEditorDialog initialLatex="ab" onConfirm={onConfirm} onClose={onClose} />);
  const source = screen.getByLabelText('LaTex source') as HTMLTextAreaElement;
  source.setSelectionRange(1, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Insert integral' }));
  expect(source.value).toBe('a\\intb');
});

it('disables confirm and announces an error for invalid Latex', () => {
  render(<LatexEditorDialog onConfirm={onConfirm} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText('LaTex source'), { target: { value: '\\frac{' } });
  expect(screen.getByRole('status')).not.toHaveTextContent('');
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
});
```

- [ ] **Step 2: Run the dialog test to verify it fails**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/LatexEditorDialog.test.tsx`

Expected: FAIL because `LatexEditorDialog` does not exist.

- [ ] **Step 3: Implement the modal and responsive UI**

```tsx
export function LatexEditorDialog({ initialLatex = '', onConfirm, onClose, labels }: LatexEditorDialogProps) {
  const [latex, setLatex] = useState(initialLatex);
  const rendered = useMemo(() => renderLatexSource(latex), [latex]);
  const confirm = () => {
    if ('error' in rendered || !latex.trim()) return;
    const { scrollWidth, scrollHeight } = previewRef.current ?? { scrollWidth: 0, scrollHeight: 0 };
    onConfirm({ latex, html: rendered.html, width: Math.max(120, scrollWidth + 32), height: Math.max(48, scrollHeight + 32) });
  };
  // Dialog with textarea + preview on the left, symbol/preset tabs on the right.
}
```

Use a fixed overlay, `role="dialog"`, `aria-modal="true"`, an `aria-live`
error region, escape-to-cancel, focus the textarea on mount, and return focus to
the opener. Add CSS grid columns for desktop and one-column layout under 720px.
Palette items must be icons or rendered formula samples with `title` and
`aria-label`, not text-filled generic buttons.

- [ ] **Step 4: Run the dialog test to verify it passes**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/LatexEditorDialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the dialog**

```bash
git add packages/@openmaic/renderer/src/editing-ui/latex/LatexEditorDialog.tsx \
  packages/@openmaic/renderer/src/editing-ui/styles.ts \
  packages/@openmaic/renderer/src/editing-ui/index.ts \
  packages/@openmaic/renderer/test/editing-ui/LatexEditorDialog.test.tsx
git commit -m "feat(renderer): add latex editor dialog"
```

### Task 3: Compose Insert and Selected-Element Editing in Renderer UI

**Files:**
- Create: `packages/@openmaic/renderer/src/editing-ui/latex/LatexToolbarOverlay.tsx`
- Modify: `packages/@openmaic/renderer/src/editing-ui/EditableSlideCanvasWithUI.tsx`
- Modify: `packages/@openmaic/renderer/src/editing-ui/types.ts`
- Modify: `packages/@openmaic/renderer/src/editing-ui/index.ts`
- Modify: `packages/@openmaic/renderer/test/editing-ui/InsertToolbar.test.tsx`
- Create: `packages/@openmaic/renderer/test/editing-ui/LatexEditorOverlay.test.tsx`

**Interfaces:**
- Consumes `latexEditor?: LatexEditorOptions` on `EditableSlideCanvasWithUIProps`.
- Consumes a selected, unlocked `PPTLatexElement` from `canvasProps.slide`.
- Produces an automatically appended `insert-latex` `InsertToolbarItem` and a
  selected-Latex edit trigger that both open the same dialog state.

- [ ] **Step 1: Write failing UI composition tests**

```tsx
it('appends the Formula icon to the renderer insert toolbar and opens the shared dialog', () => {
  render(
    <EditableSlideCanvasWithUI
      slide={slide}
      selection={{ elementIds: [] }}
      onSelectionChange={vi.fn()}
      onElementsChange={vi.fn()}
      latexEditor={{ onInsert, onUpdate }}
      insertToolbar={{ items: [] }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Insert formula' }));
  expect(screen.getByRole('dialog', { name: 'Formula editor' })).toBeVisible();
});

it('opens the same dialog prefilled with the selected Latex source and calls onUpdate', () => {
  render(
    <EditableSlideCanvasWithUI
      slide={{ ...slide, elements: [latexElement] }}
      selection={{ elementIds: ['formula-1'], primaryId: 'formula-1' }}
      onSelectionChange={vi.fn()}
      onElementsChange={vi.fn()}
      latexEditor={{ onInsert, onUpdate }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit formula' }));
  expect(screen.getByLabelText('LaTex source')).toHaveValue('x^2');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(onUpdate).toHaveBeenCalledWith('formula-1', expect.objectContaining({ latex: 'x^2' }));
});
```

- [ ] **Step 2: Run composition tests to verify they fail**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/InsertToolbar.test.tsx test/editing-ui/LatexEditorOverlay.test.tsx`

Expected: FAIL because no Latex option or overlay exists.

- [ ] **Step 3: Implement one shared dialog controller**

```tsx
type LatexDialogState = { mode: 'insert' } | { mode: 'edit'; element: PPTLatexElement } | null;

const [latexDialog, setLatexDialog] = useState<LatexDialogState>(null);
const completeLatex = (result: LatexEditorResult) => {
  if (latexDialog?.mode === 'edit') latexEditor?.onUpdate(latexDialog.element.id, result);
  else latexEditor?.onInsert(result);
  setLatexDialog(null);
};
```

Append the Formula (`Sigma`) icon to the existing injected toolbar only when
`latexEditor` is configured. Render `LatexToolbarOverlay` for exactly one
selected unlocked Latex element, anchored to `elementIdPrefix + element.id` and
containing a tooltip-equipped edit icon. Both handlers update the same
`latexDialog` state and render one `LatexEditorDialog` at the wrapper root.

- [ ] **Step 4: Run composition tests to verify they pass**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/InsertToolbar.test.tsx test/editing-ui/LatexEditorOverlay.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the renderer UI composition**

```bash
git add packages/@openmaic/renderer/src/editing-ui/latex/LatexToolbarOverlay.tsx \
  packages/@openmaic/renderer/src/editing-ui/EditableSlideCanvasWithUI.tsx \
  packages/@openmaic/renderer/src/editing-ui/types.ts \
  packages/@openmaic/renderer/src/editing-ui/index.ts \
  packages/@openmaic/renderer/test/editing-ui/InsertToolbar.test.tsx \
  packages/@openmaic/renderer/test/editing-ui/LatexEditorOverlay.test.tsx
git commit -m "feat(renderer): compose latex insert and edit UI"
```

### Task 4: Wire App Host, DSL Factory, and Localized Labels

**Files:**
- Modify: `lib/edit/slide-edit-elements.ts`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Modify: `tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`
- Modify: `tests/edit/surfaces/slide/insert-items.test.ts`
- Modify: `lib/i18n/locales/ar-SA.json`
- Modify: `lib/i18n/locales/en-US.json`
- Modify: `lib/i18n/locales/es-MX.json`
- Modify: `lib/i18n/locales/ja-JP.json`
- Modify: `lib/i18n/locales/ko-KR.json`
- Modify: `lib/i18n/locales/pt-BR.json`
- Modify: `lib/i18n/locales/ru-RU.json`
- Modify: `lib/i18n/locales/zh-CN.json`
- Modify: `lib/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes `LatexEditorResult` through the editing-ui public API.
- Produces `createDefaultLatexElement(id, result): PPTLatexElement`.
- `latexEditor.onInsert(result)` emits one `element.add`; `onUpdate(id, result)` emits one `element.update` with only `latex`, `html`, `width`, and `height`.

- [ ] **Step 1: Write failing host tests**

```tsx
it('exposes the Formula insert item and commits a confirmed result as one element.add history entry', async () => {
  process.env[flag] = 'true';
  const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');
  renderToStaticMarkup(createElement(SlideCanvas));
  lastRendererProps?.latexEditor?.onInsert({ latex: 'x^2', html: '<span class="katex">x²</span>', width: 120, height: 48 });
  expect(mockCommitContent).toHaveBeenCalledWith(
    expect.objectContaining({ canvas: expect.objectContaining({ elements: expect.arrayContaining([
      expect.objectContaining({ type: 'latex', latex: 'x^2', width: 120, height: 48 }),
    ]) }) }),
    true,
  );
});

it('updates a selected formula through the same history path without resetting color or align', async () => {
  process.env[flag] = 'true';
  const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');
  renderToStaticMarkup(createElement(SlideCanvas));
  lastRendererProps?.latexEditor?.onUpdate('formula-1', {
    latex: '\\frac{a}{b}', html: '<span class="katex">a/b</span>', width: 160, height: 60,
  });
  expect(mockCommitContent).toHaveBeenCalledWith(
    expect.objectContaining({ canvas: expect.objectContaining({ elements: expect.arrayContaining([
      expect.objectContaining({ id: 'formula-1', latex: '\\frac{a}{b}', color: '#2563eb', align: 'center' }),
    ]) }) }),
    true,
  );
});
```

- [ ] **Step 2: Run host tests to verify they fail**

Run: `pnpm exec vitest run tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts tests/edit/surfaces/slide/insert-items.test.ts`

Expected: FAIL because `latexEditor` and the Latex element factory do not exist.

- [ ] **Step 3: Implement factory and host callbacks**

```ts
export function createDefaultLatexElement(id: string, result: LatexEditorResult): PPTLatexElement {
  return { id, type: 'latex', left: 160, top: 160, rotate: 0, fixedRatio: true,
    color: '#333333', align: 'center', ...result };
}
```

In `RendererEditorCanvas`, pass `latexEditor` to `EditableSlideCanvasWithUI`.
The insert callback creates an id with `createElementId('latex')`, sends one
`element.add` through `handleElementsChange`, then selects that id. The update
callback sends one `element.update` with the result fields only, preserving
position, rotation, color, alignment, locking, and grouping. Add labels under
`edit.insert.formula` and `edit.latex.*` in every locale.

- [ ] **Step 4: Run host tests and i18n validation**

Run: `pnpm exec vitest run tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts tests/edit/surfaces/slide/insert-items.test.ts && pnpm check:i18n-keys`

Expected: PASS.

- [ ] **Step 5: Commit the App integration**

```bash
git add lib/edit/slide-edit-elements.ts components/edit/surfaces/slide/SlideCanvas.tsx \
  tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts \
  tests/edit/surfaces/slide/insert-items.test.ts lib/i18n/locales
git commit -m "feat(editor): add renderer latex insertion and editing"
```

### Task 5: Complete Regression Verification and Browser Acceptance

**Files:**
- Modify only files needed to correct verified test/build failures from Tasks 1-4.

**Interfaces:**
- Consumes the complete dialog, UI, and App-host contracts from Tasks 1-4.
- Produces a built renderer package and a browser acceptance checklist.

- [ ] **Step 1: Run focused Latex regression suites**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing-ui/latex-editor.test.ts test/editing-ui/LatexEditorDialog.test.tsx test/editing-ui/LatexEditorOverlay.test.tsx && pnpm exec vitest run tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`

Expected: PASS.

- [ ] **Step 2: Run package and repository verification serially**

Run: `pnpm --dir packages/@openmaic/renderer test && pnpm --dir packages/@openmaic/renderer run build && pnpm exec tsc --noEmit && pnpm test && pnpm check:i18n-keys && git diff --check`

Expected: every command exits 0. Run serially because the renderer build clears
and regenerates `packages/@openmaic/renderer/dist`.

- [ ] **Step 3: Perform the browser acceptance flow on port 3001**

1. Enable `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED=true` and refresh a slide editor.
2. Click the Formula icon in the left insert toolbar; verify source input,
   preview, symbols, presets, Cancel, and Confirm.
3. Insert `\\frac{a}{b}`; verify one selected formula with correct KaTeX rendering.
4. Undo, redo, and refresh; verify the formula is removed/restored/persisted.
5. Select that formula and press Edit formula; verify the dialog is prefilled.
6. Change it to `\\int_0^1 x^2 dx`, confirm, and verify position/color/alignment
   are retained while content and dimensions update.
7. Try malformed source; verify inline error and disabled confirmation, then Cancel.
8. Disable the feature flag and refresh; verify the legacy editor is still used.

- [ ] **Step 4: Inspect the final diff and report any verification-only correction separately**

Run: `git diff --check && git status --short`

Expected: no whitespace errors. If verification exposed a defect, include the
specific corrected files in the final feature commit; do not add an empty
verification-only commit.
