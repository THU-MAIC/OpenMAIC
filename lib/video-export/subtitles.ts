/**
 * Subtitle serialization — `VideoTimeline` cues → SRT / WebVTT text.
 *
 * The IR already carries a first-class `subtitles` track (one cue per non-empty
 * speech action, on the global wall-clock; see the `timeline` pass), so this is a
 * pure formatting step over {@link SubtitleCue}, not a re-derivation. Keeping it
 * here — a single source, unit-tested without a browser — means the burned-in
 * (P3) and sidecar subtitle paths can never drift.
 *
 * Pure: depends only on the IR types.
 */
import type { SubtitleCue } from './ir';

/** Clamp + format a millisecond offset as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
function formatTimestamp(ms: number, msSeparator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

/**
 * Normalize cue text for a subtitle file: CRLF/CR → LF and trailing whitespace
 * trimmed, so a cue never emits a blank line that would prematurely end the block.
 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/g, '');
}

/**
 * Cues an exporter would actually write: non-empty text and a positive span.
 * A zero/negative span (e.g. an estimated 0ms narration) would produce an
 * invalid cue, so it is dropped here rather than emitted malformed.
 */
export function usableCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.filter((cue) => cue.endMs > cue.startMs && normalizeText(cue.text).length > 0);
}

/** Serialize cues to SubRip (`.srt`). Indices are re-numbered 1-based over the usable cues. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  const blocks = usableCues(cues).map((cue, i) => {
    const start = formatTimestamp(cue.startMs, ',');
    const end = formatTimestamp(cue.endMs, ',');
    return `${i + 1}\n${start} --> ${end}\n${normalizeText(cue.text)}\n`;
  });
  return blocks.join('\n');
}

/** Serialize cues to WebVTT (`.vtt`). */
export function toVtt(cues: readonly SubtitleCue[]): string {
  const blocks = usableCues(cues).map((cue) => {
    const start = formatTimestamp(cue.startMs, '.');
    const end = formatTimestamp(cue.endMs, '.');
    return `${start} --> ${end}\n${normalizeText(cue.text)}\n`;
  });
  return `WEBVTT\n\n${blocks.join('\n')}`;
}
