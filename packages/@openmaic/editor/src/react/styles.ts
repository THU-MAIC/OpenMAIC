import { createTextProseStyles } from '@openmaic/renderer';

export const EDITOR_REACT_STYLES = `
${createTextProseStyles('.renderer-prosemirror-editor .ProseMirror')}

.renderer-prosemirror-editor {
  cursor: text;
}

.renderer-prosemirror-editor :focus,
.renderer-prosemirror-editor :focus-visible {
  outline: none;
}

`;
