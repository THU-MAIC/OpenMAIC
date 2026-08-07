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
