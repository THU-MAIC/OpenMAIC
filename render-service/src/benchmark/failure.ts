import type { FailureClassification } from './types.js';

export function classifyFailure(input: {
  timedOut: boolean;
  failedStage?: string;
  error?: string;
}): FailureClassification {
  if (input.timedOut) return 'timeout';
  const text = `${input.failedStage ?? ''} ${input.error ?? ''}`.toLowerCase();
  if (/ffprobe|duration mismatch|a\/v drift|validation|representative/.test(text)) {
    return 'validation';
  }
  if (/compile|preprocess|probe/.test(text)) return 'compile';
  if (/video.?extract|extract.?video/.test(text)) return 'video-extract';
  if (/audio|mix/.test(text)) return 'audio';
  if (/capture|browser|chrom|frame/.test(text)) return 'capture';
  if (/encode|encoder/.test(text)) return 'encode';
  if (/assembl|mux|faststart/.test(text)) return 'assemble';
  return 'unknown';
}
