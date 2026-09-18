import { createTextProseStyles } from '@openmaic/renderer';

export const EDITOR_REACT_STYLES = `
${createTextProseStyles('.renderer-prosemirror-editor .ProseMirror')}

/* ProseMirror inserts this zero-size caret helper after inline atoms.
   Host image resets (e.g. Tailwind display:block) must not add a new line. */
.renderer-prosemirror-editor img.ProseMirror-separator {
  display: inline !important;
  border: none !important;
  margin: 0 !important;
}

.renderer-prosemirror-editor {
  cursor: text;
}

.renderer-prosemirror-editor :focus,
.renderer-prosemirror-editor :focus-visible {
  outline: none;
}

`;
