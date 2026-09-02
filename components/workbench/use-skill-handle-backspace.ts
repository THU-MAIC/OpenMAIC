'use client';

/**
 * Backspace deletes a whole skill handle, in every composer.
 *
 * A handle is one object to the reader and one to the model, so character-by-
 * character deletion leaves `/k12-core-literacy-plannin` — a handle that resolves
 * to nothing. This makes the token the unit of deletion without giving up the
 * native `<textarea>`: the value stays plain text, so IME composition, the undo
 * stack, paste and autosize are all still the browser's.
 *
 * IME FIRST. `isComposing` (and the legacy 229 keycode) short-circuit everything:
 * rewriting the value under a live composition is exactly how Chinese input breaks,
 * and this product is Chinese-first. Anything other than the narrow case — a
 * selection, a caret mid-handle, ordinary prose — falls through to the browser.
 */
import { useCallback, type KeyboardEvent } from 'react';

import { deleteSkillHandleBefore } from '@/lib/workbench/composer-skills';

export function useSkillHandleBackspace(
  setDraft: (next: string) => void,
  /**
   * Record where the caret goes once the controlled value has landed. A callback
   * rather than the caller's ref: the composer owns that ref, and a hook reaching
   * into a value handed to it is both a lint error here and the wrong shape.
   */
  onCaret: (caret: number) => void,
): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  return useCallback(
    (event) => {
      if (event.key !== 'Backspace') return false;
      if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
      const textarea = event.currentTarget;
      // A selection already has a unit of deletion: its own.
      if (textarea.selectionStart !== textarea.selectionEnd) return false;
      const deletion = deleteSkillHandleBefore(textarea.value, textarea.selectionStart ?? 0);
      if (!deletion) return false;
      event.preventDefault();
      onCaret(deletion.caret);
      setDraft(deletion.draft);
      return true;
    },
    [onCaret, setDraft],
  );
}
