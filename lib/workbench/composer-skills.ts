/**
 * The composer's `/` — a text affordance, and nothing more.
 *
 * Loading a skill was briefly a PILL: the picked skill sat above the input box
 * as a chip, and sending prefixed the message with its `/handle`. That was a
 * lie about what a skill is here. Nothing on the server parses the prefix —
 * `<available_skills>` lists every installed skill in the system prompt and the
 * agent opens the one it needs with pi's native `read` — so the handle is TEXT
 * AIMED AT THE MODEL. Dressing text up as structure cost a staging store, a
 * dedupe rule, a ceiling and a toast for hitting it, all to model something the
 * user could already type.
 *
 * So the `/` menu is a completion, not a picker: choosing an entry writes
 * `/skill-name ` into the draft and leaves the caret after it. What the user
 * sees in the box is exactly what will be sent, they can write as many handles
 * as they like, and deleting one is Backspace.
 *
 * It IS drawn as a chip now, but the chip is how the TEXT looks, not a thing
 * beside it: `segmentSkillHandles` below finds the handles in the draft and the
 * composer's input draws each as one inline node (`lib/workbench/composer-doc`).
 * The value never stops being the plain string, which is the difference that
 * matters: no staging store, no ceiling, no dedupe.
 *
 * EVERY composer, without exception — the conversation's and the shared launch
 * panel's. An input box is an input box. The launch surfaces briefly
 * kept a chip on the argument that a skill there becomes the session's `skillId`;
 * that column still exists and still feeds the outline constraint check, but the
 * SERVER now reads the leading handle out of the message text to fill it
 * (`inferSkillIdFromPrompt`), so the guardrail survives with no UI special case.
 */

import { composerTokens, tokenAtCaret, type ComposerToken } from './composer-tokens';

/**
 * The skill NAME a token spells, or null when the token is not a handle at all.
 *
 * One shape, three callers (the trigger, the insertion, the chip), so none of them can disagree about what a handle looks like:
 * a `/` starting the token, and a name with no second slash in it. `'/'` on its
 * own spells the EMPTY name — a live query with nothing typed after it yet, which
 * is what opens the menu on the bare keystroke — and every caller that needs a
 * real skill checks the name is non-empty by looking it up.
 */
export function skillHandleName(token: string): string | null {
  if (!token.startsWith('/')) return null;
  const name = token.slice(1);
  return name.includes('/') ? null : name;
}

/**
 * The `/` query being typed AT THE CARET, or null.
 *
 * The caret is what makes this the token the user is on rather than the draft as a
 * whole. It used to test the whole draft (`draft.startsWith('/')`, then "no
 * whitespace anywhere in the rest"), which meant the menu could be triggered
 * exactly once per draft: after `/stage-design ` the draft contained a space, so a
 * second `/` — mid-sentence or at the end — opened nothing at all.
 *
 * `caret` is REQUIRED, and callers pass the textarea's live `selectionStart`. An
 * optional one defaulting to the end of the draft is precisely the stale value
 * this replaced.
 */
export function slashQuery(draft: string, caret: number): string | null {
  return skillHandleName(tokenAtCaret(draft, caret).text);
}

/** A draft with a handle written into it, and where the caret goes next. */
export interface SkillHandleInsertion {
  readonly draft: string;
  readonly caret: number;
}

/** One run of the draft: a handle the input draws as a chip, or plain text. */
export interface ComposerTextSegment {
  readonly text: string;
  /** True when this run is a handle that resolves to an installed skill. */
  readonly skill: boolean;
}

/**
 * Cut the draft into plain runs and skill-handle runs, in order.
 *
 * This is what a skill chip is: the composer's input draws each handle this
 * returns as one inline node (`lib/workbench/composer-doc`). Concatenating every
 * `text` back together always reproduces the draft exactly.
 *
 * A handle counts only when the WHOLE token names an INSTALLED skill:
 * `/stage-design` is a pill, `/stage-desig` and `/whatever` are ordinary text, and
 * so is `/stage-design,` (the comma is part of the token, and the agent would not
 * resolve that either). It walks `composerTokens`, the same boundary definition
 * the trigger uses, so they agree on where a handle ends.
 *
 * ONE ACCEPTED IMPRECISION: text carries no provenance, so a handle the user
 * PASTED renders identically to one the `/` menu inserted. There is nothing in a
 * string to tell them apart — and nothing downstream that would care if there
 * were, because the agent reads both exactly the same way.
 */
export function segmentSkillHandles(
  text: string,
  installedNames: readonly string[],
): readonly ComposerTextSegment[] {
  if (text.length === 0) return [];
  const installed = new Set(installedNames);
  if (installed.size === 0) return [{ text, skill: false }];
  const segments: ComposerTextSegment[] = [];
  let plainFrom = 0;
  for (const token of composerTokens(text)) {
    const name = skillHandleName(token.text);
    if (!name || !installed.has(name)) continue;
    if (token.start > plainFrom)
      segments.push({ text: text.slice(plainFrom, token.start), skill: false });
    segments.push({ text: token.text, skill: true });
    plainFrom = token.end;
  }
  if (plainFrom < text.length) segments.push({ text: text.slice(plainFrom), skill: false });
  return segments;
}

/**
 * Write `/skill-name` into the draft AT THE CARET.
 *
 * Two entry points, one rule. From the `/` menu the caret sits in the query being
 * typed, so the handle REPLACES that token — otherwise the half-typed
 * multi-byte query would be left in the sentence. From the `+` menu
 * there is no query, so the handle opens a slot exactly where the caret is; it used
 * to be appended to the end of the draft, which put it somewhere the user was not
 * looking as soon as they had written a sentence.
 *
 * Spacing is added only where it is missing, on both sides — no double spaces, and
 * no handle glued to the word next to it. The trailing space is not cosmetic: the
 * caret lands after it, so the next keystroke starts the sentence (or the next
 * handle) rather than extending the one just inserted into a name that no longer
 * resolves.
 */
export function insertSkillHandle(
  draft: string,
  skillName: string,
  caret: number,
): SkillHandleInsertion {
  const handle = `/${skillName}`;
  const token: ComposerToken = tokenAtCaret(draft, caret);
  // A `/query` at the caret is what the menu was filtering, so it is what the
  // pick replaces. Anything else — prose, an `@` token, whitespace — is left
  // alone and the handle goes in beside it.
  const replacing = skillHandleName(token.text) !== null;
  // Where a handle that replaces nothing goes: the caret itself when it sits on
  // whitespace, and otherwise the END of the token it is in — a `+`-menu pick with
  // the caret parked inside a word should not saw that word in half.
  const at = token.start === token.end ? token.start : token.end;
  const start = replacing ? token.start : at;
  const end = replacing ? token.end : start;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const inserted = `${lead}${handle}${trail}`;
  return { draft: `${before}${inserted}${after}`, caret: start + inserted.length };
}

/**
 * Seed a `/` query token at the caret — the skill button's way of opening the
 * slash menu without typing (P1 fix: the naive `draft.slice(0, at) + '/'`
 * glued the `/` onto the word before the caret when it sat mid-word or at a
 * word's end, producing a token like `course/` that no query could match, so
 * the menu never opened and repeat clicks stacked `///`).
 *
 * The same normalization `insertSkillHandle` applies to a full handle, applied
 * to the bare trigger: a LEAD SPACE when the caret is not on whitespace (and
 * the `/` must start its own token), a TRAIL SPACE only when a non-space word
 * follows and would otherwise absorb the token. Returns null when a query is
 * already live at the caret — there is nothing to seed.
 */
export function seedSlashQuery(draft: string, caret: number): SkillHandleInsertion | null {
  if (slashQuery(draft, caret) !== null) return null;
  const token: ComposerToken = tokenAtCaret(draft, caret);
  // When the caret is inside a word, the seed goes to the word's END — sawing
  // `cour|se` into `cour /se` would be worse than appending after it.
  const at = token.start === token.end ? token.start : token.end;
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const inserted = `${lead}/`;
  return { draft: `${before}${inserted}${after}`, caret: at + inserted.length };
}
