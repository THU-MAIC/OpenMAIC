/**
 * Pure text and voice helpers for browser-native speech (Web Speech API).
 *
 * No DOM access here: everything takes the voice list and text as arguments,
 * so the classroom engine, discussion and preview resolve voices and split
 * text the same way, and the rules can be tested in a plain Node environment.
 */

const CJK_LANG_THRESHOLD = 0.3;

// U+0110/0111 (đ), U+01A0/01A1 (ơ), U+01AF/01B0 (ư) and the U+1EA0–U+1EF9
// precomposed block (ớ, ừ, ồ, ế, ấ, …) never occur in French or Romanian
// Latin, so one occurrence marks Vietnamese. Bare ă/â/ê/ô do occur in
// Romanian (and ê/ô in lone French words like "fête"), so they only count
// toward a ratio — this does not fully exclude Romanian prose, which is
// acceptable because narration chunks follow the course language.
const VI_DECIDER_RE = /[đĐơƠưƯ\u1EA0-\u1EF9]/;
const VI_BROAD_RE = /[ăâêôĂÂÊÔ]/g;
const VI_BROAD_THRESHOLD = 0.02;

/** Detect Chinese/Vietnamese text, retaining the UI's Chinese region when available. */
export function detectSpeechLang(text: string, fallbackLang = 'en-US'): string {
  if (!text) return fallbackLang || 'en-US';
  const cjkRatio = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / text.length;
  if (cjkRatio > CJK_LANG_THRESHOLD) {
    // The character ratio identifies the language but not the region, so a
    // Chinese UI keeps the user's own region for the voice.
    return fallbackLang.toLowerCase().startsWith('zh-') ? fallbackLang : 'zh-CN';
  }
  if (VI_DECIDER_RE.test(text)) return 'vi-VN';
  if ((text.match(VI_BROAD_RE) || []).length / text.length > VI_BROAD_THRESHOLD) return 'vi-VN';
  return fallbackLang || 'en-US';
}

/**
 * Resolve a browser voice by voiceURI, name, or lang, with language fallback by text.
 *
 * Without a matching voice the language is detected from the text, so the
 * browser picks a voice for it. Vietnamese additionally binds an installed
 * `vi` voice when one exists, since browsers otherwise read Vietnamese text
 * with an English voice.
 */
export function resolveBrowserVoice(
  voices: readonly SpeechSynthesisVoice[],
  voiceNameOrLang: string,
  text: string,
  locale?: string,
): { voice: SpeechSynthesisVoice | null; lang: string } {
  const target = voiceNameOrLang.trim();
  const matchedVoice =
    target && target !== 'default'
      ? voices.find(
          (voice) => voice.voiceURI === target || voice.name === target || voice.lang === target,
        ) || null
      : null;
  if (matchedVoice) {
    return { voice: matchedVoice, lang: matchedVoice.lang || detectSpeechLang(text, locale) };
  }

  const lang = detectSpeechLang(text, locale);
  if (lang === 'vi-VN') {
    const viVoice = voices.find((voice) => voice.lang?.toLowerCase().startsWith('vi'));
    if (viVoice) return { voice: viVoice, lang: viVoice.lang };
  }
  return { voice: null, lang };
}

const CJK_TERMINATORS = new Set(['\u3002', '\uFF01', '\uFF1F']); // fullwidth period, ! and ?
const LATIN_TERMINATORS = new Set(['.', '!', '?']);
/** Closing quotes and brackets that belong to the sentence they follow. */
const CLOSERS = new Set([
  '"',
  "'",
  ')',
  ']',
  '\u2019', // right single quote
  '\u201D', // right double quote
  '\u300D', // right corner bracket
  '\u300F', // right white corner bracket
  '\u3011', // right black lenticular bracket
  '\u300B', // right double angle bracket
  '\uFF09', // fullwidth right parenthesis
  '\u00BB', // right guillemet
  '\u203A', // right single guillemet
]);
/** Closing guillemets, which French typography separates from the text by a space. */
const SPACED_CLOSERS = new Set(['\u00BB', '\u203A']);
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const LOWERCASE_RE = /\p{Ll}/u;
/** Opening punctuation that may precede a word. */
const WORD_START_RE = /[\s([{"'\u2018\u201C\u00AB\u2039]/;
/** A single capital letter and a period: a name initial, never a sentence. */
const LONE_INITIAL_RE = /^\p{Lu}\.$/u;
/**
 * Abbreviations that are practically never the last word of a sentence:
 * titles before a name, and "e.g", "i.e", "cf", "vs" before an example.
 * Abbreviations and letters that can end one ("U.S.", "etc.", "Inc.",
 * "plan A.") are not listed: before a capitalized word they count as a
 * sentence end, since an extra pause costs less than merging two sentences
 * into one utterance.
 */
const NEVER_LAST_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'e.g',
  'i.e',
  'cf',
  'vs',
]);

/** Abbreviations that introduce a reference number ("Fig. 2", "p. 12"). */
const REFERENCE_ABBREVIATIONS = new Set([
  'fig',
  'figs',
  'ch',
  'chap',
  'sec',
  'eq',
  'eqs',
  'no',
  'nos',
  'vol',
  'p',
  'pp',
  'art',
  'tab',
  'ex',
]);

/** The word that ends with the period at `dot`, lowercased, without that period. */
function wordBeforePeriod(text: string, dot: number): string {
  let start = dot;
  while (start > 0 && !WORD_START_RE.test(text[start - 1])) start--;
  return text.slice(start, dot).toLowerCase();
}

/**
 * Whether the period at `dot` belongs to an abbreviation that does not end
 * the sentence: one of {@link NEVER_LAST_ABBREVIATIONS}, or one of
 * {@link REFERENCE_ABBREVIATIONS} followed by a number.
 */
function isNeverLastAbbreviation(text: string, dot: number): boolean {
  const word = wordBeforePeriod(text, dot);
  if (NEVER_LAST_ABBREVIATIONS.has(word)) return true;
  if (!REFERENCE_ABBREVIATIONS.has(word)) return false;
  let next = dot + 1;
  while (next < text.length && /[^\S\n]/.test(text[next])) next++;
  return next < text.length && /\p{N}/u.test(text[next]);
}

/**
 * Whether Latin sentence punctuation ending just before `i` ends a sentence:
 * it must be followed by whitespace (or the end of the text), so decimals,
 * versions, domains and URLs stay whole. When `lowercaseContinues`, a next
 * word starting in lowercase continues the sentence: after periods ("e.g. a
 * ruler", "Wait... and then") and after `!` or `?` inside closing quotes
 * ('"Why?" she asked'). Otherwise `!` and `?` end a sentence before any word.
 * A lone period after some abbreviations is checked separately (see
 * {@link isNeverLastAbbreviation}).
 */
function endsLatinSentence(text: string, i: number, lowercaseContinues: boolean): boolean {
  if (i >= text.length) return true;
  if (!/\s/.test(text[i])) return false;
  if (!lowercaseContinues) return true;
  let next = i;
  while (next < text.length && /\s/.test(text[next])) next++;
  return next >= text.length || !LOWERCASE_RE.test(text[next]);
}

/**
 * Split text into sentences for sequential playback.
 *
 * - CJK sentence punctuation (fullwidth period, ! and ?) ends a sentence
 *   where it stands; Latin `.`, `!` and `?` only as described in
 *   {@link endsLatinSentence}, and a period not after a title, "e.g.",
 *   "i.e.", "cf." or "vs.", or before the number of a reference such as
 *   "Fig. 2" ({@link isNeverLastAbbreviation}). A newline always ends one.
 * - A run of punctuation ("?!", "...") and the closing quotes or brackets
 *   after it stay with the sentence they end.
 * - A fragment with no letters or digits is merged into the sentence before
 *   it (or after it, at the start), so punctuation is never spoken alone. A
 *   fragment that is only a name initial ("J.") is merged into the sentence
 *   after it, so "J. K. Rowling" stays whole. Nothing is merged across a
 *   newline.
 *
 * Blank text yields no sentences (an empty utterance does not reliably fire
 * `onend` in Chromium); text without sentence punctuation is one sentence.
 */
export function splitSpeechSentences(text: string): string[] {
  const ends: number[] = [];
  /** Ends at a newline: nothing is merged across them. */
  const lineEnds = new Set<number>();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      ends.push(i);
      lineEnds.add(i);
      i++;
      continue;
    }
    if (!CJK_TERMINATORS.has(ch) && !LATIN_TERMINATORS.has(ch)) {
      i++;
      continue;
    }
    const runStart = i;
    let cjk = false;
    while (i < text.length && (CJK_TERMINATORS.has(text[i]) || LATIN_TERMINATORS.has(text[i]))) {
      if (CJK_TERMINATORS.has(text[i])) cjk = true;
      i++;
    }
    const run = text.slice(runStart, i);
    const lonePeriod = run === '.';
    const runEnd = i;
    for (;;) {
      let next = i;
      while (next < text.length && /[^\S\n]/.test(text[next])) next++;
      if (
        next < text.length &&
        CLOSERS.has(text[next]) &&
        (next === i || SPACED_CLOSERS.has(text[next]))
      ) {
        i = next + 1;
      } else {
        break;
      }
    }
    const lowercaseContinues = /^\.+$/.test(run) || i > runEnd;
    if (cjk) ends.push(i);
    else if (
      endsLatinSentence(text, i, lowercaseContinues) &&
      !(lonePeriod && isNeverLastAbbreviation(text, runStart))
    ) {
      ends.push(i);
    }
  }
  ends.push(text.length);

  const pieces: Array<{ start: number; end: number }> = [];
  let start = 0;
  let pendingStart: number | null = null;
  for (const end of ends) {
    const piece = text.slice(start, end);
    if (piece.trim()) {
      if (LONE_INITIAL_RE.test(piece.trim())) {
        pendingStart ??= start;
      } else if (WORD_CHAR_RE.test(piece)) {
        pieces.push({ start: pendingStart ?? start, end });
        pendingStart = null;
      } else if (pendingStart === null && pieces.length > 0 && !lineEnds.has(start)) {
        pieces[pieces.length - 1].end = end;
      } else {
        pendingStart ??= start;
      }
    }
    if (pendingStart !== null && lineEnds.has(end)) {
      pieces.push({ start: pendingStart, end });
      pendingStart = null;
    }
    start = end;
  }
  if (pendingStart !== null) pieces.push({ start: pendingStart, end: text.length });
  return pieces.map(({ start: from, end }) => text.slice(from, end).trim());
}
