/**
 * `@` mentions written into the composer's text, as `/skill` handles are.
 *
 * A course or a knowledge-base material picked from the `@` menu used to sit
 * as a pill above the box. It now goes where the caret was, as an `@label`
 * run of the draft that the composer's mirror draws with the skill handle's
 * own highlight, so the sentence reads as written ("compare @Fractions with
 * @worksheet.pdf"). The reference itself is unchanged: it still rides with the
 * message as a course ref or a staged material, and the `@label` runs are
 * taken out of the text that is sent, so the server sees exactly what it saw
 * before.
 *
 * The label is the item's name, shortened inside the token when it is long
 * (the textarea holds real text, so truncation has to happen in the text), and
 * numbered when two picks would otherwise read the same. Everything here is
 * pure; the composers keep the list of mentions and call these.
 */

export interface InlineMention {
  /** What the draft holds for it, `@` included. Unique among the draft's mentions. */
  readonly label: string;
  readonly kind: 'course' | 'material';
  /** The course's stage id, or the material's id. */
  readonly id: string;
  /** The item's whole name (the label may shorten it). */
  readonly name: string;
}

/** Characters of a name kept inside its token before it is shortened. */
export const MENTION_NAME_MAX = 18;

/** `@name`, shortened with an ellipsis past {@link MENTION_NAME_MAX}, numbered if taken. */
export function mentionLabel(name: string, taken: readonly string[]): string {
  const clean = name.replace(/\s+/g, ' ').trim() || '?';
  const chars = [...clean];
  const short =
    chars.length > MENTION_NAME_MAX ? `${chars.slice(0, MENTION_NAME_MAX - 1).join('')}…` : clean;
  const base = `@${short}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const label = `${base} ${n}`;
    if (!taken.includes(label)) return label;
  }
}

/**
 * Write `label` at `[start, end)` — the `@query` the menu was filtering, or an
 * empty range at the caret — with a space on each side only where one is
 * missing, the caret after the trailing one so typing goes on.
 */
export function insertMention(
  draft: string,
  label: string,
  start: number,
  end: number = start,
): { readonly draft: string; readonly caret: number } {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const inserted = `${lead}${label}${trail}`;
  return { draft: `${before}${inserted}${after}`, caret: start + inserted.length };
}

/**
 * Backspace at the end of a mention takes the whole mention (and the space the
 * insertion left after it, when the caret sits past that space). Anywhere else
 * it is the browser's one character.
 */
export function deleteMentionBefore(
  draft: string,
  caret: number,
  mentions: readonly InlineMention[],
): { readonly draft: string; readonly caret: number; readonly mention: InlineMention } | null {
  if (caret <= 0 || caret > draft.length) return null;
  const probe = draft[caret - 1] === ' ' ? caret - 1 : caret;
  for (const mention of mentions) {
    const start = probe - mention.label.length;
    if (start < 0 || draft.slice(start, probe) !== mention.label) continue;
    return { draft: draft.slice(0, start) + draft.slice(caret), caret: start, mention };
  }
  return null;
}

/** The mentions whose label the draft still holds; the rest were edited away. */
export function mentionsInDraft(
  draft: string,
  mentions: readonly InlineMention[],
): readonly InlineMention[] {
  const kept = mentions.filter((mention) => draft.includes(mention.label));
  return kept.length === mentions.length ? mentions : kept;
}

/**
 * The text that is sent: the draft without its mention runs. Each run takes
 * one space with it (the one after it, or else the one before), so the words
 * around it close up and the teacher's own spacing elsewhere is untouched.
 */
export function stripMentions(draft: string, mentions: readonly InlineMention[]): string {
  let text = draft;
  // Longest first, so `@Unit 1 2` is not cut as `@Unit 1` and a stray ` 2`.
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    let at = text.indexOf(mention.label);
    while (at >= 0) {
      let start = at;
      let end = at + mention.label.length;
      if (text[end] === ' ') end += 1;
      else if (start > 0 && text[start - 1] === ' ') start -= 1;
      text = text.slice(0, start) + text.slice(end);
      at = text.indexOf(mention.label, start);
    }
  }
  return text.trim();
}

/**
 * The text that is sent: each mention written out as `@` and the item's whole
 * name, so the message reads as the teacher wrote it and its bubble can show
 * the mention where it stood. The references themselves go as before.
 */
export function expandMentions(draft: string, mentions: readonly InlineMention[]): string {
  let text = draft;
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    text = text.split(mention.label).join(`@${mention.name}`);
  }
  return text.trim();
}

/** One run of text, split where a mention's label stands. */
export interface MentionSegment {
  readonly text: string;
  readonly mention: boolean;
}

export function segmentMentions(
  text: string,
  labels: readonly string[],
): readonly MentionSegment[] {
  if (labels.length === 0 || text.length === 0) return [{ text, mention: false }];
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  const segments: MentionSegment[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const label = sorted.find((candidate) => text.startsWith(candidate, i));
    if (label) {
      if (plain) segments.push({ text: plain, mention: false });
      plain = '';
      segments.push({ text: label, mention: true });
      i += label.length;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) segments.push({ text: plain, mention: false });
  return segments;
}
