import type { DirectorScenario, JudgeResult } from './types';

/**
 * Judge a director decision against a scenario's expected outcome.
 *
 * For premature-END scenarios the judgment is deterministic: the director
 * must NOT emit END when a student question is unresolved. No LLM needed.
 */
export function judgeDecision(
  scenario: DirectorScenario,
  shouldEnd: boolean,
): JudgeResult {
  if (scenario.category === 'premature-end') {
    const pass = shouldEnd === scenario.expected.shouldEnd;
    return {
      pass,
      reason: pass
        ? 'Director correctly did not emit END with an unresolved student question.'
        : `Director emitted END prematurely — expected shouldEnd=${scenario.expected.shouldEnd}, got ${shouldEnd}.`,
    };
  }

  return {
    pass: shouldEnd === scenario.expected.shouldEnd,
    reason: `shouldEnd=${shouldEnd}, expected=${scenario.expected.shouldEnd}`,
  };
}
