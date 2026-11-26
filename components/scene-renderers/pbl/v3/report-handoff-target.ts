/** Pick the report entrance the learner could click in the current layout. */
export function reportHandoffTarget(root: HTMLElement | null): HTMLButtonElement | null {
  if (!root) return null;
  const receipts = root.querySelectorAll<HTMLButtonElement>(
    '.pbl-conversation-scroll [data-pbl-report-handoff]',
  );
  const header = root.querySelector<HTMLButtonElement>('[data-pbl-tour="report"]');
  // Radix temporarily disables pointer events outside its modal. Probe the underlying
  // workbench synchronously so scrolling, the task drawer and floating panes count.
  const previous = root.style.pointerEvents;
  root.style.pointerEvents = 'auto';
  try {
    for (const button of [receipts[receipts.length - 1], header]) {
      if (!button || button.disabled) continue;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const hit = root.ownerDocument
        .elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        .find(
          (element) => !element.closest('.pbl-completion-overlay, [data-pbl-completion-dialog]'),
        );
      if (hit && button.contains(hit)) return button;
    }
    return null;
  } finally {
    root.style.pointerEvents = previous;
  }
}
