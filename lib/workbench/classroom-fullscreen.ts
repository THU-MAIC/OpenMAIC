/**
 * Whether an Escape keypress should collapse the full-screen classroom back to
 * the split view.
 *
 * Only an Escape nobody else handled: the editor deselecting an element, a
 * menu or a dialog closing, an input clearing itself all mark the event (or
 * own the focus), and taking the keypress from them would collapse the
 * classroom out from under the thing being dismissed.
 */
export function shouldCollapseFullscreenOnEscape(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing' | 'target'>,
  doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  const target = event.target as (EventTarget & Partial<HTMLElement>) | null;
  if (target && typeof target.closest === 'function') {
    if (
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
      )
    ) {
      return false;
    }
  }
  // A modal or a menu is open somewhere: Escape is for it first.
  if (doc?.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) {
    return false;
  }
  return true;
}
