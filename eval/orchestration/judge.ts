/**
 * Deterministic verdict for premature-END scenarios.
 *
 * The bug we are guarding against is "director picks END while a student
 * question is unresolved". For each sample, the only thing that matters is
 * whether the director chose END. No LLM-as-judge here — END/not-END is
 * binary and reading parseDirectorDecision is sufficient.
 */

import { parseDirectorDecision } from '@/lib/orchestration/director-prompt';

export interface ParsedSample {
  decision: 'END' | 'USER' | string;
  isEnd: boolean;
}

export function classifyDecision(raw: string): ParsedSample {
  const parsed = parseDirectorDecision(raw);
  if (parsed.shouldEnd || !parsed.nextAgentId) {
    return { decision: 'END', isEnd: true };
  }
  return { decision: parsed.nextAgentId, isEnd: false };
}

/**
 * END rate over non-errored samples. Errored samples are excluded so API
 * failures (e.g. provider 'Forbidden') don't masquerade as deterministic END
 * behavior. Returns 0 if no samples are usable.
 */
export function endRate(samples: { isEnd: boolean; error?: string }[]): number {
  const usable = samples.filter((s) => !s.error);
  if (usable.length === 0) return 0;
  const ends = usable.filter((s) => s.isEnd).length;
  return ends / usable.length;
}
