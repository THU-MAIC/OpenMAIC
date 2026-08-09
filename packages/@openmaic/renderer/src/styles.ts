/**
 * Package-level CSS rules that can't be expressed inline (descendant selectors,
 * keyframes, pseudo-classes). Rendered once via `<style>` at the top of
 * `<SlideCanvas>` so the package stays self-contained without Tailwind.
 *
 * The `.slide-renderer-prose` rules are intentionally minimal "browser-default
 * resets" — they un-do the user-agent stylesheet (1em <p> margin, KaTeX block
 * margin) so the slide JSON is the single source of truth. They do not
 * positively style anything; spacing comes from the data via the
 * `--paragraphSpace` CSS variable, which is unset when undefined in data.
 */
export const SLIDE_RENDERER_STYLES = `
.slide-renderer-prose p {
  margin-top: 0;
  margin-bottom: var(--paragraphSpace, 0);
}
.slide-renderer-prose p:last-child {
  margin-bottom: 0;
}
.slide-renderer-prose .katex-display {
  margin: 0 !important;
}
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
