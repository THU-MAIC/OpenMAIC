export interface DecisionRecord<TChosen = string> {
  id: string;
  chosen: TChosen;
  revision: number;
  rationale?: string;
}

export interface DecisionProgress<TChosen = string> {
  decisions: readonly DecisionRecord<TChosen>[];
}

export function recordDecision<TChosen>(
  progress: DecisionProgress<TChosen>,
  decisionId: string,
  chosen: TChosen,
  rationale?: string,
): DecisionProgress<TChosen> {
  const existingIndex = progress.decisions.findIndex((decision) => decision.id === decisionId);
  if (existingIndex < 0) {
    return {
      ...progress,
      decisions: [
        ...progress.decisions,
        { id: decisionId, chosen, revision: 0, ...(rationale === undefined ? {} : { rationale }) },
      ],
    };
  }

  return {
    ...progress,
    decisions: progress.decisions.map((decision, index) =>
      index === existingIndex
        ? {
            id: decision.id,
            chosen,
            revision: decision.revision + 1,
            ...(rationale === undefined ? {} : { rationale }),
          }
        : decision,
    ),
  };
}

/** Validate response shape, not the learner's reasoning or engineering correctness. */
export function isDecisionResponseValid(
  definition: {
    responseType?: 'choice' | 'text';
    requiresRationale?: boolean;
    options: readonly { id: string }[];
  },
  response: { chosen?: unknown; rationale?: unknown },
): boolean {
  if (typeof response.chosen !== 'string') return false;
  if (response.rationale !== undefined && typeof response.rationale !== 'string') return false;
  if (
    definition.requiresRationale &&
    !(typeof response.rationale === 'string' && response.rationale.trim())
  )
    return false;
  return definition.responseType === 'text'
    ? response.chosen.trim().length > 0
    : definition.options.some((option) => option.id === response.chosen);
}
