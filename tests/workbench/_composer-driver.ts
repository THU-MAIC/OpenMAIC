/**
 * Drive a composer's real input from a test. jsdom has no keyboard or IME that
 * ProseMirror could read, so text goes in through the same handle the composers
 * use, as one edit; real input is covered by the browser specs.
 */
import { composerInputHandleOf } from '@/components/workbench/composer-input';

// jsdom lays nothing out; ProseMirror asks a range for its rectangles when it
// scrolls the selection into view.
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
}

export const COMPOSER_INPUT = '[data-composer-input]';

function handle(input: Element) {
  const found = composerInputHandleOf(input);
  if (!found) throw new Error('not a composer input');
  return found;
}

export const composerText = (input: Element): string => handle(input).value;

/** Replace everything in the box, as selecting all and typing does. */
export function setComposerText(input: Element, text: string): void {
  const box = handle(input);
  box.setSelectionRange(0, box.value.length);
  box.insertText(text);
}

/** Type at the end of what the box holds. */
export function appendComposerText(input: Element, text: string): void {
  const box = handle(input);
  box.setSelectionRange(box.value.length, box.value.length);
  box.insertText(text);
}

export const moveComposerCaret = (input: Element, offset: number): void =>
  handle(input).setSelectionRange(offset, offset);
