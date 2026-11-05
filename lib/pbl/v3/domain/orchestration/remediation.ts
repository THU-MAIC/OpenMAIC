import type { EvaluationResult, RemediationHint } from './types';

export function createRemediationHint(
  evaluation: EvaluationResult,
  input: { id: string; attempt: number },
): RemediationHint {
  const safeFeedback = [
    evaluation.publicFeedback,
    evaluation.publicDiagnostics?.summary,
    ...(evaluation.publicDiagnostics?.locations ?? []).map(
      (location) => `- ${location.file}:${location.line} (${location.code})`,
    ),
    ...(evaluation.publicDiagnostics?.checks ?? []).map((check) => `- ${check}`),
  ]
    .filter((value): value is string => value !== undefined)
    .join('\n');
  return {
    id: input.id,
    kind: evaluation.status === 'error' ? 'evaluation_recovery' : 'implementation_repair',
    target: 'coder',
    reason: evaluation.failureKind ?? evaluation.status,
    attempt: input.attempt,
    evaluationId: evaluation.id,
    ...(safeFeedback === '' ? {} : { safeFeedback }),
  };
}
