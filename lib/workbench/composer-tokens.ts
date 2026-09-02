/**
 * Where a composer token starts and ends — ONE definition for every rule that
 * has an opinion about `/handle` text.
 *
 * A TOKEN IS A RUN OF NON-WHITESPACE. That is the whole model, and it is the
 * model because it is the one the reader already has: `/stage-design` is one
 * thing and a space ends it. Newlines and tabs count as whitespace, so a handle
 * cannot span a line break.
 *
 * WHY THIS FILE EXISTS. Several rules used to state that definition separately,
 * and they anchored it to different places: the pill layer scanned every token
 * in the draft, while the triggers matched only a token that started the WHOLE
 * draft and ran to its end. The fix is one shared definition, not several
 * agreeing ones.
 *
 * PURE, AND CARET-INDEXED. Everything here takes an offset into the string and
 * no DOM: the composer reads `selectionStart` and passes it in, which is what
 * makes "the token the user is typing right now" testable without a browser.
 */

/** One whitespace-delimited run of a draft, with the slice it occupies. */
export interface ComposerToken {
  readonly text: string;
  /** Index of the token's first character. */
  readonly start: number;
  /** Index just past the token's last character. */
  readonly end: number;
}

const WHITESPACE = /\s/;

/** Out-of-range carets are clamped rather than rejected: an offset is untrusted. */
function clamp(text: string, caret: number): number {
  if (!Number.isFinite(caret)) return text.length;
  return Math.min(text.length, Math.max(0, Math.trunc(caret)));
}

/**
 * The token CONTAINING the caret — the thing being typed right now.
 *
 * Scans left from the caret to the nearest whitespace (or the start of the draft)
 * and right to the nearest whitespace (or its end). A caret sitting ON whitespace
 * belongs to no token, and gets an EMPTY one at its own offset rather than null:
 * every caller then asks the same question of the same shape ("does this token
 * start with `/`?"), and the answer for whitespace is simply no.
 */
export function tokenAtCaret(text: string, caret: number): ComposerToken {
  const at = clamp(text, caret);
  let start = at;
  while (start > 0 && !WHITESPACE.test(text[start - 1]!)) start -= 1;
  let end = at;
  while (end < text.length && !WHITESPACE.test(text[end]!)) end += 1;
  return { text: text.slice(start, end), start, end };
}

/**
 * Every token in the draft, in order. The pill layer's view of the same
 * definition `tokenAtCaret` gives the triggers — so "what gets a pill" and "what
 * opens a menu" cannot disagree about where a handle ends.
 */
export function composerTokens(text: string): readonly ComposerToken[] {
  const tokens: ComposerToken[] = [];
  let index = 0;
  while (index < text.length) {
    if (WHITESPACE.test(text[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && !WHITESPACE.test(text[index]!)) index += 1;
    tokens.push({ text: text.slice(start, index), start, end: index });
  }
  return tokens;
}
