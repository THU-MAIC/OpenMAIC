# @openmaic/editor

Composable slide-editing package for OpenMAIC.

- `@openmaic/editor/core`: document operations, transactions, and undo/redo history.
- `@openmaic/editor/react`: editable slide interaction surface and rich-text editors.
- `@openmaic/editor/ui`: editor toolbars, insertion controls, and context menus.

## Dependencies

```text
@openmaic/editor
├─> @openmaic/renderer   (reuses the read-only slide renderer)
└─> @openmaic/dsl        (document and element data contracts)
```

`@openmaic/renderer` does not depend on `@openmaic/editor`, so the package boundary remains
one-way and free of circular dependencies.

The host application owns controlled document state, selection, persistence, and the final
`onTransaction` sink. `@openmaic/editor` owns built-in element adapters, insertion defaults,
toolbars, dialogs, clipboard behavior, shortcuts, and the conversion of UI intents into editor
transactions. Hosts may provide stable capabilities such as locale, element ID generation, and a
generic asset picker; they do not configure individual element types.

## Install and styles

The editor uses the renderer and DSL directly. Install them alongside the renderer's required
peers and KaTeX so the host can import their public styles:

```bash
pnpm add @openmaic/editor @openmaic/dsl @openmaic/renderer \
  react react-dom motion tailwindcss katex
```

Import the renderer fonts and KaTeX stylesheet once from the application shell:

```tsx
import '@openmaic/renderer/fonts.css';
import 'katex/dist/katex.min.css';
```

The renderer emits Tailwind 4 classes. Configure Tailwind to scan
`node_modules/@openmaic/renderer/dist/**/*.{js,cjs}` as described in the
[`@openmaic/renderer` setup](https://www.npmjs.com/package/@openmaic/renderer#tailwind-4-setup).
Charts and code elements also need the renderer's optional `echarts` and `shiki` peers
respectively.

## Editor surface

`EditableSlideCanvasWithUI` is a controlled editor surface. The host provides the current slide
and selection, then applies and persists the canonical transactions emitted by the editor. This
complete example keeps undo history in React state; a production host can persist
`history.present` whenever it changes:

```tsx
import { useCallback, useState } from 'react';
import type { SlideContent } from '@openmaic/dsl';
import { applyEditorTransaction, createEditorHistory, type EditorTransaction } from '@openmaic/editor/core';
import { EMPTY_SELECTION, type Selection } from '@openmaic/editor/react';
import { EditableSlideCanvasWithUI, type EditorInsertItem } from '@openmaic/editor/ui';

const insertItems: EditorInsertItem[] = ['text', 'image', 'table', 'audio'];

export function SlideEditor({ initialContent }: { initialContent: SlideContent }) {
  const [history, setHistory] = useState(() => createEditorHistory(initialContent));
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const applyTransaction = useCallback((transaction: EditorTransaction) => {
    setHistory((current) => applyEditorTransaction(current, transaction));
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 480 }}>
      <EditableSlideCanvasWithUI
        slide={history.present.canvas}
        selection={selection}
        onSelectionChange={setSelection}
        onTransaction={applyTransaction}
        insertItems={insertItems}
        snapping
      />
    </div>
  );
}
```

`insertItems` is optional. It controls both which insert buttons are visible and their display
order. When omitted, the toolbar uses this built-in order:

```text
text, image, table, chart, line, background, latex, video, audio
```

Pass an empty array to hide the insert toolbar. Repeated values are displayed once, at their first
position. This option only changes insert-button visibility and ordering; it does not disable
rendering or editing existing elements of those types.

## Localization

The editor has built-in Chinese and English labels. A host can provide any other language through
a framework-independent `translate` capability:

```tsx
const host: EditorHostCapabilities = {
  locale,
  translate: (key, params, defaultMessage) =>
    appTranslate(`edit.${key}`, { ...params, defaultValue: defaultMessage }),
};

<EditableSlideCanvasWithUI host={host} {...props} />;
```

Changing `locale` or `translate` causes visible editor controls and open overlays to use the new
language without resetting the controlled document or selection. The editor does not depend on a
specific i18n library; `appTranslate` may come from i18next, react-intl, a local dictionary, or any
other translation system. Missing external translations can use `defaultMessage`, which contains
the editor's built-in fallback label.
