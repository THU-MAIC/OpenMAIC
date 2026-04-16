/**
 * Mirrors PlaybackEngine reading-timer / pacing logic so UI can estimate
 * narration duration when no measurable HTML audio is available.
 */
const CJK_LANG_THRESHOLD = 0.3;

export function estimateLectureSpeechMs(text: string, playbackSpeed: number): number {
  if (!text) return 2000;
  const cjkCount = (
    text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
  ).length;
  const isCJK = cjkCount > text.length * CJK_LANG_THRESHOLD;
  const speed = Math.max(0.5, playbackSpeed || 1);
  const rawMs = isCJK
    ? Math.max(2000, text.length * 150)
    : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
  return rawMs / speed;
}
