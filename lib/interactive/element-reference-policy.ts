/** Tags that cannot be selected as static Interactive courseware evidence. */
export const INTERACTIVE_REFERENCE_EXCLUDED_TAG_NAMES = [
  'html',
  'head',
  'body',
  'script',
  'style',
  'link',
  'meta',
  'noscript',
  'template',
  'iframe',
  'canvas',
  'noembed',
  'noframes',
  'plaintext',
  'xmp',
] as const;

const INTERACTIVE_REFERENCE_EXCLUDED_TAG_SET = new Set<string>(
  INTERACTIVE_REFERENCE_EXCLUDED_TAG_NAMES,
);

export function isInteractiveReferenceExcludedTag(tagName: string): boolean {
  return INTERACTIVE_REFERENCE_EXCLUDED_TAG_SET.has(tagName.toLowerCase());
}
