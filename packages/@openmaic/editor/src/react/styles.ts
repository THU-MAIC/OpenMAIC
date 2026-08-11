export const EDITOR_REACT_STYLES = `
.renderer-prosemirror-editor {
  cursor: text;
}

.renderer-prosemirror-editor :focus,
.renderer-prosemirror-editor :focus-visible {
  outline: none;
}

.renderer-prosemirror-editor ul {
  list-style-position: outside !important;
  padding-inline-start: 1.5rem !important;
}

.renderer-prosemirror-editor ul:not([style*='list-style-type']) {
  list-style-type: disc !important;
}

.renderer-prosemirror-editor ol {
  list-style-position: outside !important;
  padding-inline-start: 1.5rem !important;
}

.renderer-prosemirror-editor ol:not([style*='list-style-type']) {
  list-style-type: decimal !important;
}

.renderer-prosemirror-editor li {
  display: list-item !important;
}
`;
