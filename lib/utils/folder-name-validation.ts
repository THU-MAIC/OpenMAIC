/**
 * Folder name validation (display-width based).
 *
 * The rule counts a character's *display width* rather than its code-point
 * count: full-width characters (CJK, full-width punctuation) score 2 and
 * half-width characters score 1. This keeps the visible length a folder name
 * occupies on a card roughly constant across languages, instead of letting a
 * short-by-character-count CJK name run just as long as an English one.
 */

/** Maximum display width for a folder name (~20 CJK glyphs / ~40 Latin chars). */
export const FOLDER_NAME_MAX_WIDTH = 40;

/** Soft cap on the number of folders a user can create. */
export const FOLDER_COUNT_LIMIT = 50;

/**
 * A folder-name rejection shared by the local (IndexedDB), server route and PG
 * data layers (moved here so the server-side provider can throw the same typed
 * error without pulling the Dexie store into a server bundle; `stage-storage.ts`
 * re-exports it, keeping every import site intact).
 *
 * `kind` is the machine code the UI maps to a localized message — the same
 * contract as {@link FolderNameValidationError} plus `duplicate` / `limit`.
 */
export class FolderNameError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'tooLong' | 'duplicate' | 'limit',
  ) {
    super(message);
    this.name = 'FolderNameError';
  }
}

/**
 * Full-width character ranges (CJK, Hangul, full-width/half-width forms, CJK
 * punctuation, kana). Hoisted to a module const so it is compiled once rather
 * than per character.
 */
const FULL_WIDTH_CHARS =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u3040-\u30FF]/;

/**
 * Status returned by {@link validateFolderName}. `kind` is a stable machine
 * code so the UI can map it to a localized message; this module never returns
 * a translated string.
 */
export type FolderNameValidationError = 'empty' | 'tooLong';

export type FolderNameValidation =
  | { ok: true }
  | { ok: false; kind: FolderNameValidationError; width: number };

/**
 * Compute a string's display width: full-width characters = 2, others = 1.
 *
 * Covers common full-width ranges (CJK unified ideographs, CJK compatibility,
 * Hangul syllables, full-width/half-width forms, CJK punctuation, kana). A
 * prototype-grade implementation — sufficient for folder names; it does not
 * model combining marks or the full East Asian Width algorithm.
 */
export function displayNameWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    width += FULL_WIDTH_CHARS.test(ch) ? 2 : 1;
  }
  return width;
}

/**
 * Validate a folder name. Returns `{ ok: true }` or a typed error. Does NOT
 * check for duplicate names — that requires the existing-folders list and is
 * the caller's responsibility.
 */
export function validateFolderName(name: string): FolderNameValidation {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, kind: 'empty', width: 0 };
  const width = displayNameWidth(trimmed);
  if (width > FOLDER_NAME_MAX_WIDTH) {
    return { ok: false, kind: 'tooLong', width };
  }
  return { ok: true };
}
