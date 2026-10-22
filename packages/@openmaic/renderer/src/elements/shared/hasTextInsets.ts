/** Imported PPTX labels carry their own text box padding on the outer div. */
export function hasTextInsets(content: string): boolean {
  const hasExplicitTextInsets = /^\s*<div\b[^>]*\sdata-pptx-text-insets\s*=\s*(["'])true\1/i.test(
    content,
  );
  // Legacy saved slides predate the marker but retain an inline padding style.
  return (
    hasExplicitTextInsets || /^\s*<div\b[^>]*\sstyle\s*=\s*["'][^"']*\bpadding\s*:/i.test(content)
  );
}
