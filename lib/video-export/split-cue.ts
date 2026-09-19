/**
 * Subtitle cue splitting — long narration → short, readable cues.
 *
 * The timeline pass emits one {@link SubtitleCue} per non-empty `speech` action,
 * whose text is the *whole* narration paragraph. Burned into the video that is a
 * 4–6 line block that covers the lower half of the slide; as a sidecar SRT/VTT
 * it is one cue that lingers for the whole paragraph. This module splits each cue
 * into short pieces (1–2 lines) and distributes the parent's time window across
 * them, so both the burned-in overlay and the exported SRT/VTT read line-by-line.
 *
 * Timing is by **character weight**, not a per-word timestamp: the TTS pipeline
 * only stores a whole-clip duration (`AudioFileRecord.duration`), so there is no
 * finer alignment to use. Narration pace is roughly uniform, so a piece's share
 * of the window ∝ its share of the (weighted) characters keeps audio and text in
 * sync to within a few hundred ms — and the burned-in overlay and the sidecar
 * file use the exact same cues, so they can never drift from each other.
 *
 * Pure: depends only on the IR types. No `@/`, no DOM — inside the
 * `lib/video-export/**` purity boundary.
 */
import type { SubtitleCue } from './ir';

/**
 * Readability budget per cue, in "CJK-equivalent" units (a wide CJK glyph is 1,
 * a Latin/ASCII char ~0.5). ~40 units ≈ two comfortable lines of a bottom
 * caption band at the default font size.
 */
const MAX_UNITS = 40;

/** A piece shorter than this (ms) is merged into a neighbour so it doesn't flash. */
const MIN_CUE_MS = 1200;

/**
 * Clause punctuation used to break an *over-budget* sentence into cue-sized
 * pieces, kept with the preceding clause. Includes both semicolons (`；;`),
 * which {@link splitSentences} intentionally does not treat as sentence ends
 * (they join clauses, not sentences), so a long semicolon-joined sentence still
 * breaks here rather than overflowing the readability budget.
 */
const SECONDARY = /([，、,:：；;—])/;

/**
 * Locale-agnostic ICU sentence segmenter, constructed once. Its Unicode
 * sentence-boundary rules already preserve decimals (`3.14`), versions (`v1.2`),
 * acronyms (`U.S.`), inline abbreviations (`e.g.`), ellipses, and CJK terminators
 * (`。！？…`) — so the boundary logic no longer needs a hand-rolled punctuation
 * heuristic. See {@link splitSentences} for the one gap it leaves.
 */
const SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/**
 * Titles that take a following proper noun in the *same* sentence — `Dr. Smith`,
 * `Prof. Wang`, `Mr. Lee`. ICU ends a sentence at their trailing dot when a
 * capitalized word follows, so {@link splitSentences} re-joins that one segment.
 *
 * Deliberately narrow: only titles, not sentence-*trailing* abbreviations like
 * `Inc.`, `Ltd.`, `etc.`, `vs.`, or `No.`. Those legitimately end sentences
 * (`…made by Acme Inc. Next point.`), and a capitalized word after them is
 * usually a new sentence — merging them would delete real boundaries. Titles
 * before a *number* (`No. 5`, `Fig. 3`) or a *lowercase* word (`etc. and…`) are
 * already kept whole by ICU and need no merge. Lower-cased, no trailing dot.
 */
const CONTINUING_TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr']);

/** The previous segment ends in a title abbreviation whose sentence continues (`… Dr.`). */
function endsWithContinuingTitle(text: string): boolean {
  const m = /(\p{L}+)\.\s*$/u.exec(text);
  return !!m && CONTINUING_TITLES.has(m[1].toLowerCase());
}

/** True for a wide (CJK / full-width) code point that occupies a full cell. */
function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    (c >= 0x2e80 && c <= 0x9fff) || // CJK radicals … unified ideographs
    (c >= 0xa000 && c <= 0xa4cf) || // Yi
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK compatibility forms
    (c >= 0xff00 && c <= 0xff60) || // full-width forms
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd) // CJK ext B+
  );
}

/** Visual width of a string in CJK-equivalent units (wide=1, other=0.5). */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += isWide(ch) ? 1 : 0.5;
  return units;
}

/**
 * Weight used for time allocation: counts glyphs that take reading time (wide=1,
 * other visible=0.5) and ignores whitespace, so a piece's time share tracks how
 * much there is to *read*, not raw length. Always ≥ a small floor so an
 * all-punctuation piece still gets a sliver of time rather than zero.
 */
function timeWeight(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    w += isWide(ch) ? 1 : 0.5;
  }
  return Math.max(w, 0.5);
}

/** Hard-wrap a run with no usable punctuation into ≤ MAX_UNITS chunks. */
function hardWrap(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let units = 0;
  for (const ch of text) {
    const u = isWide(ch) ? 1 : 0.5;
    if (units + u > MAX_UNITS && buf) {
      out.push(buf);
      buf = '';
      units = 0;
    }
    buf += ch;
    units += u;
  }
  if (buf) out.push(buf);
  return out;
}

/** Split on a punctuation regex, re-attaching each delimiter to its preceding chunk. */
function splitKeepingDelimiters(text: string, re: RegExp): string[] {
  const parts = text.split(re);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = (parts[i] ?? '') + (parts[i + 1] ?? '');
    if (chunk) out.push(chunk);
  }
  return out;
}

/**
 * Split text into sentences at genuine boundaries, keeping the terminating
 * punctuation with its sentence.
 *
 * Boundary detection is delegated to ICU via {@link SENTENCE_SEGMENTER}, which
 * handles the multilingual/CJK cases (`。！？…`, decimals, versions, `e.g.`,
 * `U.S.`, ellipses) that a hand-rolled punctuation scan got wrong. ICU leaves one
 * narration gap: it ends a sentence after a title like `Dr.` / `Prof.` when a
 * capitalized word follows (`Dr. Smith` → `Dr.` / `Smith …`). A narrow post-merge
 * re-joins *that* segment — but only when all of these hold, so it never deletes a
 * real boundary:
 *   - the previous segment ends in a continuing title ({@link CONTINUING_TITLES}),
 *     not a sentence-trailing abbreviation like `Inc.`/`etc.`;
 *   - the previous segment does not end at an explicit newline (a hard boundary);
 *   - the next segment starts with a capital (the proper noun that ICU mis-split;
 *     a lowercase or numeric continuation was never split by ICU in the first place).
 * Blank segments (whitespace between sentences) are dropped.
 */
function splitSentences(text: string): string[] {
  const segments = [...SENTENCE_SEGMENTER.segment(text)].map((s) => s.segment);
  const merged: string[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    const continuesTitle =
      prev !== undefined &&
      !/\n\s*$/.test(prev) &&
      /^\s*\p{Lu}/u.test(seg) &&
      endsWithContinuingTitle(prev);
    if (continuesTitle) {
      merged[merged.length - 1] = prev + seg;
    } else {
      merged.push(seg);
    }
  }
  return merged.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split narration text into short pieces (each ≤ ~MAX_UNITS), preferring
 * sentence boundaries, then clause punctuation, then a hard wrap. Whitespace-only
 * input yields no pieces. Adjacent under-budget sentences are greedily packed so
 * a short sentence isn't left alone on its own cue.
 */
export function splitCueText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Sentences.
  const sentences = splitSentences(trimmed);

  // 2. Break any over-budget sentence on clause punctuation, then hard-wrap.
  //    Sentences within budget stay one-per-cue (line-by-line subtitles); a
  //    too-short tail is folded in later by the MIN_CUE_MS timing merge, so no
  //    re-packing of full sentences here (that would rebuild the 2-line block).
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (textUnits(sentence) <= MAX_UNITS) {
      pieces.push(sentence);
      continue;
    }
    const clauses = splitKeepingDelimiters(sentence, SECONDARY)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (textUnits(clause) <= MAX_UNITS) pieces.push(clause);
      else pieces.push(...hardWrap(clause));
    }
  }

  return pieces;
}

/**
 * Join two adjacent cue-text pieces being merged into one cue. A space is
 * inserted only at a Latin word boundary (both sides narrow); CJK text is not
 * space-separated, so if either side of the seam is a wide glyph the pieces are
 * joined directly — otherwise merging e.g. `我们开始。` + `看这里` would inject a
 * spurious space into the caption.
 */
function joinCueText(prev: string, next: string): string {
  const left = [...prev].pop() ?? '';
  const right = next[0] ?? '';
  const gap = left && right && !isWide(left) && !isWide(right) ? ' ' : '';
  return `${prev}${gap}${next}`;
}

/**
 * Split one cue into multiple, distributing its `[startMs, endMs]` window across
 * the text pieces in proportion to their reading weight. The pieces tile the
 * window with no gaps or overlaps; the last piece's `endMs` is pinned to the
 * parent's so integer rounding can't drift the track. Pieces whose allotted span
 * would be shorter than {@link MIN_CUE_MS} are merged forward to avoid flashing.
 *
 * A cue that splits into one piece (or whose window is non-positive) is returned
 * unchanged except for text-trim, so already-short narration is untouched.
 */
export function splitCue(cue: SubtitleCue): SubtitleCue[] {
  const pieces = splitCueText(cue.text);
  const windowMs = cue.endMs - cue.startMs;
  if (pieces.length <= 1 || windowMs <= 0) {
    const text = pieces[0] ?? cue.text.trim();
    return [{ ...cue, text }];
  }

  const weights = pieces.map(timeWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Cumulative boundaries by weight, rounded to ms; first starts at the parent
  // start, last ends at the parent end.
  const bounds: number[] = [cue.startMs];
  let acc = 0;
  for (let i = 0; i < pieces.length - 1; i++) {
    acc += weights[i];
    bounds.push(cue.startMs + Math.round((windowMs * acc) / totalWeight));
  }
  bounds.push(cue.endMs);

  const raw: SubtitleCue[] = pieces.map((text, i) => ({
    index: cue.index,
    sceneId: cue.sceneId,
    actionId: cue.actionId,
    startMs: bounds[i],
    endMs: bounds[i + 1],
    text,
  }));

  // Merge any sub-MIN_CUE_MS piece into the next (or previous, for the last one)
  // so the visible cue never flashes. Boundaries stay contiguous.
  const merged: SubtitleCue[] = [];
  for (const c of raw) {
    const prev = merged[merged.length - 1];
    if (prev && c.endMs - c.startMs < MIN_CUE_MS) {
      merged[merged.length - 1] = { ...prev, endMs: c.endMs, text: joinCueText(prev.text, c.text) };
    } else {
      merged.push(c);
    }
  }
  // If the very first piece was the short one, it may still be < MIN; fold it in.
  if (merged.length > 1 && merged[0].endMs - merged[0].startMs < MIN_CUE_MS) {
    const [first, second, ...rest] = merged;
    return [
      { ...second, startMs: first.startMs, text: joinCueText(first.text, second.text) },
      ...rest,
    ];
  }
  return merged;
}

/**
 * Split every cue in a track and renumber `index` 1:1 over the result. The IR's
 * subtitle track is replaced with this so the burned-in overlay and the SRT/VTT
 * serializers all consume the same short cues.
 */
export function splitCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.flatMap((c) => splitCue(c)).map((c, index) => ({ ...c, index }));
}
