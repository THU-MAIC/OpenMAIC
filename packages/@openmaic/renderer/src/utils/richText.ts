/**
 * `content` is an HTML-string contract. Only markup-free values can safely use
 * `white-space: pre-line`: a newline between rich HTML block tags is source
 * formatting, not visible slide content.
 */
const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<![^>]*>/i;

export function preservesPlainTextLineBreaks(content: string): boolean {
  return !HTML_MARKUP_PATTERN.test(content);
}
