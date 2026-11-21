/**
 * Shared TTS utilities used by both client-side and server-side generation.
 */

import { speechForTts, speechMathSpans, splitSpeechFormulaPairs } from '@openmaic/dsl';
import type { TTSProviderId } from './types';
import type { Action, SpeechAction } from '@/lib/types/action';
import { createLogger } from '@/lib/logger';

const log = createLogger('TTS');

/** Provider-specific max text length limits. */
export const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>> = {
  'glm-tts': 1024,
};

/**
 * Split long text into chunks that respect sentence boundaries.
 * Tries splitting at sentence-ending punctuation first, then clause-level
 * punctuation, and finally hard-splits at maxLength as a last resort.
 */
export function splitLongSpeechText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized || normalized.length <= maxLength) return [normalized];

  const units = normalized
    .split(/(?<=[。！？!?；;：:\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  const appendUnit = (unit: string) => {
    if (!current) {
      current = unit;
      return;
    }
    if ((current + unit).length <= maxLength) {
      current += unit;
      return;
    }
    pushChunk(current);
    current = unit;
  };

  const hardSplitUnit = (unit: string) => {
    const parts = unit.split(/(?<=[，,、])/u).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length <= maxLength) appendUnit(part);
        else hardSplitUnit(part);
      }
      return;
    }

    let start = 0;
    while (start < unit.length) {
      appendUnit(unit.slice(start, start + maxLength));
      start += maxLength;
    }
  };

  for (const unit of units.length > 0 ? units : [normalized]) {
    if (unit.length <= maxLength) appendUnit(unit);
    else hardSplitUnit(unit);
  }

  pushChunk(current);
  return chunks;
}

function joinUnits(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const needSpace =
    /[A-Za-z0-9.,!?;:]$/.test(prev) && /^[A-Za-z0-9\\$]/.test(next) && !prev.endsWith(' ');
  return needSpace ? `${prev} ${next}` : prev + next;
}

function maskMathSpans(
  text: string,
  maxLength: number,
): { masked: string; originals: Map<string, string> } | null {
  const spans = speechMathSpans(text);
  if (!spans.length) return null;
  const originals = new Map<string, string>();
  let code = 0xf0000;
  let masked = '';
  let cursor = 0;
  for (const span of spans) {
    const raw = text.slice(span.start, span.end);
    if (raw.length > maxLength) return null;
    let token = String.fromCodePoint(code++);
    while (text.includes(token)) token = String.fromCodePoint(code++);
    originals.set(token, raw);
    masked += text.slice(cursor, span.start) + token;
    cursor = span.end;
  }
  masked += text.slice(cursor);
  return { masked, originals };
}

function unmaskText(value: string, originals: ReadonlyMap<string, string>): string {
  return Array.from(value, (ch) => originals.get(ch) ?? ch).join('');
}

function splitDisplayText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized || normalized.length <= maxLength) return [normalized];
  const maskedState = maskMathSpans(normalized, maxLength);
  if (!maskedState) return splitLongSpeechText(normalized, maxLength);
  const { masked, originals } = maskedState;
  const rawChunks = splitLongSpeechText(masked, maxLength);
  const restored: string[] = [];
  for (const piece of rawChunks) {
    const unmasked = unmaskText(piece, originals).trim();
    if (unmasked.length <= maxLength) {
      if (unmasked) restored.push(unmasked);
      continue;
    }
    let buf = '';
    for (const ch of piece) {
      const expanded = originals.get(ch) ?? ch;
      if (buf && buf.length + expanded.length > maxLength) {
        if (buf.trim()) restored.push(buf.trim());
        buf = expanded.trimStart();
      } else {
        buf += expanded;
      }
    }
    if (buf.trim()) restored.push(buf.trim());
  }
  return restored.length > 0 ? restored : [normalized.slice(0, maxLength)];
}

function splitSentencesPreservingMath(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const maskedState = maskMathSpans(normalized, maxLength);
  const source = maskedState ? maskedState.masked : normalized;
  return source
    .split(/(?<=[。！？!?；;：:\n])/u)
    .map((part) => (maskedState ? unmaskText(part, maskedState.originals) : part).trim())
    .filter(Boolean);
}

function distributeAtoms(
  atoms: string[],
  count: number,
  maxLength: number,
  fallbackSplit: (s: string, max: number) => string[],
): string[] {
  if (count <= 1 || atoms.length <= 1) {
    return atoms.flatMap((a) => fallbackSplit(a, maxLength));
  }
  const bucketCount = Math.min(count, atoms.length);
  const totalLen = atoms.reduce((sum, a) => sum + a.length, 0);
  const buckets: string[] = [];
  let cursor = 0;
  let consumedLen = 0;
  for (let b = 0; b < bucketCount; b++) {
    const remainingBuckets = bucketCount - b;
    if (remainingBuckets === 1) {
      buckets.push(atoms.slice(cursor).reduce(joinUnits, ''));
      break;
    }
    const targetCumulative = ((b + 1) * totalLen) / bucketCount;
    let current = '';
    while (cursor < atoms.length - (remainingBuckets - 1)) {
      const candidate = joinUnits(current, atoms[cursor]);
      if (current && candidate.length > maxLength) break;
      current = candidate;
      consumedLen += atoms[cursor].length;
      cursor++;
      if (consumedLen >= targetCumulative) break;
    }
    if (!current && cursor < atoms.length) {
      current = atoms[cursor];
      consumedLen += atoms[cursor].length;
      cursor++;
    }
    buckets.push(current);
  }
  return buckets.flatMap((bucket) => fallbackSplit(bucket, maxLength)).filter(Boolean);
}

function partitionPlainInto(text: string, count: number, maxLength: number): string[] {
  const normalized = text.trim();
  const atoms = normalized
    .split(/(?<=[。！？!?；;：:，,、\s])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const units = atoms.length >= count ? atoms : Array.from(normalized).filter((c) => c.trim());
  return distributeAtoms(units, count, maxLength, splitLongSpeechText);
}

function partitionDisplayInto(text: string, count: number, maxLength: number): string[] {
  const normalized = text.trim();
  const maskedState = maskMathSpans(normalized, maxLength);
  if (!maskedState) {
    return partitionPlainInto(normalized, count, maxLength);
  }
  const { masked, originals } = maskedState;
  const rawClauseAtoms = masked
    .split(/(?<=[。！？!?；;：:，,、\s])/u)
    .map((part) => unmaskText(part, originals).trim())
    .filter(Boolean);
  if (rawClauseAtoms.length >= count) {
    return distributeAtoms(rawClauseAtoms, count, maxLength, splitDisplayText);
  }
  const charAtoms = Array.from(masked)
    .map((ch) => (originals.get(ch) ?? ch).trim())
    .filter(Boolean);
  if (charAtoms.length < count) {
    // A single unsplittable math token stays intact on screen across its spoken parts.
    return Array.from({ length: count }, () => normalized);
  }
  return distributeAtoms(charAtoms, count, maxLength, splitDisplayText);
}

function alignPairedChunks(
  display: string,
  spoken: string,
  maxLength: number,
): Array<{ text: string; spokenText?: string }> {
  let dChunks = splitDisplayText(display, maxLength);
  let sChunks = splitLongSpeechText(spoken, maxLength);
  if (dChunks.length < sChunks.length) {
    dChunks = partitionDisplayInto(display, sChunks.length, maxLength);
  }
  if (sChunks.length < dChunks.length) {
    sChunks = partitionPlainInto(spoken, dChunks.length, maxLength);
  }
  if (dChunks.length < sChunks.length) {
    dChunks = partitionDisplayInto(display, sChunks.length, maxLength);
  }
  const len = Math.max(dChunks.length, sChunks.length);
  const out: Array<{ text: string; spokenText?: string }> = [];
  for (let i = 0; i < len; i++) {
    const d = dChunks[Math.min(i, dChunks.length - 1)];
    const s = i < sChunks.length ? sChunks[i] : '.';
    out.push(s && s !== d ? { text: d, spokenText: s } : { text: d });
  }
  return out;
}

function splitPairedSpeech(
  display: string,
  spoken: string,
  maxLength: number,
): Array<{ text: string; spokenText?: string }> {
  const dSentences = splitSentencesPreservingMath(display, maxLength);
  const sSentences = splitSentencesPreservingMath(spoken, maxLength);
  if (dSentences.length !== sSentences.length || dSentences.length <= 1) {
    return alignPairedChunks(display, spoken, maxLength);
  }

  const out: Array<{ text: string; spokenText?: string }> = [];
  let curD = '';
  let curS = '';
  const flush = () => {
    if (!curD) return;
    out.push(curS && curS !== curD ? { text: curD, spokenText: curS } : { text: curD });
    curD = '';
    curS = '';
  };

  for (let i = 0; i < dSentences.length; i++) {
    const d = dSentences[i];
    const s = sSentences[i];
    if (d.length > maxLength || s.length > maxLength) {
      flush();
      out.push(...alignPairedChunks(d, s, maxLength));
      continue;
    }
    const nextD = joinUnits(curD, d);
    const nextS = joinUnits(curS, s);
    if (curD && (nextD.length > maxLength || nextS.length > maxLength)) {
      flush();
      curD = d;
      curS = s;
    } else {
      curD = nextD;
      curS = nextS;
    }
  }
  flush();
  return out;
}

/**
 * Split long speech actions into multiple shorter actions so each stays
 * within the TTS provider's text length limit. Each sub-action gets its
 * own independent audio file — no byte concatenation needed.
 */
export function splitLongSpeechActions(actions: Action[], providerId: TTSProviderId): Action[] {
  const maxLength = TTS_MAX_TEXT_LENGTH[providerId];
  if (!maxLength) return actions;

  let didSplit = false;
  const nextActions: Action[] = actions.flatMap((action) => {
    if (action.type !== 'speech' || !action.text) return [action];
    const speech = action as SpeechAction;
    const spoken = speechForTts(speech);
    if (speech.text.length <= maxLength && spoken.length <= maxLength) {
      return [action];
    }

    const views = speech.spokenText?.trim()
      ? { text: speech.text, spokenText: speech.spokenText.trim() }
      : speech.text.includes('[[')
        ? splitSpeechFormulaPairs(speech.text)
        : { text: speech.text };

    const chunks: Array<{ text: string; spokenText?: string }> = views.spokenText
      ? splitPairedSpeech(views.text, views.spokenText, maxLength)
      : splitDisplayText(views.text, maxLength).map((text) => ({ text }));

    if (
      chunks.length <= 1 &&
      chunks[0] &&
      chunks[0].text.length <= maxLength &&
      (chunks[0].spokenText ?? chunks[0].text).length <= maxLength
    ) {
      return [action];
    }
    didSplit = true;
    const { audioId: _audioId, spokenText: _spokenText, ...baseAction } = speech;

    log.info(
      `Split speech for ${providerId}: action=${action.id}, len=${action.text.length}, spokenLen=${spoken.length}, chunks=${chunks.length}`,
    );
    return chunks.map((chunk, i) => ({
      ...baseAction,
      id: `${action.id}_tts_${i + 1}`,
      text: chunk.text,
      ...(chunk.spokenText ? { spokenText: chunk.spokenText } : {}),
    }));
  });
  return didSplit ? nextActions : actions;
}
