/** Length of visible text inside HTML slide content (for reveal pacing). */
export function htmlPlainTextLength(html: string): number {
  if (!html) return 0;
  if (typeof document === 'undefined') {
    return html.replace(/<[^>]+>/g, '').length;
  }
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').length;
}
