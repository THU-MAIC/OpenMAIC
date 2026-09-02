/**
 * Package-level CSS rules that can't be expressed inline (descendant selectors,
 * keyframes, pseudo-classes). Rendered once via `<style>` at the top of
 * `<SlideCanvas>` so the package stays self-contained without Tailwind.
 *
 * The `.slide-renderer-prose` rules undo host and user-agent defaults so the
 * slide JSON is the single source of truth. Paragraph spacing comes from the
 * `--paragraphSpace` CSS variable. List rules restore semantic markers that
 * host resets such as Tailwind Preflight remove.
 */
/**
 * Generates the reset rules that define rich-text geometry inside a slide.
 *
 * Both the static renderer and the ProseMirror editor need these exact rules:
 * keeping the selector configurable lets them share one layout contract while
 * retaining their different DOM roots.
 */
export function createTextProseStyles(selector: string): string {
  return `
${selector} p {
  margin-top: 0;
  margin-bottom: var(--paragraphSpace, 0);
}
${selector} p:last-child {
  margin-bottom: 0;
}
${selector} p:empty::before {
  content: '\\00a0';
}
${selector} .katex-display {
  margin: 0 !important;
}
${selector} ul {
  list-style-position: outside !important;
  padding-inline-start: 1.5rem !important;
}
${selector} ul:not([style*="list-style-type"]) {
  list-style-type: disc !important;
}
${selector} ol {
  list-style-position: outside !important;
  padding-inline-start: 1.5rem !important;
}
${selector} ol:not([style*="list-style-type"]) {
  list-style-type: decimal !important;
}
${selector} li {
  display: list-item !important;
}
`;
}

export const SLIDE_RENDERER_STYLES = `
${createTextProseStyles('.slide-renderer-prose')}
/* Table cell inner container — matches the classroom (Vue) .cell-text design:
   tight base line-height, and a small spacing between adjacent <p> siblings
   so multi-paragraph cells don't collapse into a single visual block. The
   <p> margin reset above sets the baseline to 0; this rule re-adds spacing
   only between adjacent siblings, leaving the first/last paragraph flush. */
.slide-renderer-cell-text p + p {
  margin-top: 0.4em;
}
@keyframes slide-renderer-pulse {
  50% { opacity: 0.5; }
}
@keyframes slide-renderer-ping {
  75%, 100% { transform: scale(2); opacity: 0; }
}
@keyframes slide-renderer-code-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.slide-renderer-pulse {
  animation: slide-renderer-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
.slide-renderer-ping {
  animation: slide-renderer-ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
}
`;
