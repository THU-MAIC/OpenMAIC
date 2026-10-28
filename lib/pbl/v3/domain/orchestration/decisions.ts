export interface DecisionRecord<TChosen = string> {
  id: string;
  chosen: TChosen;
  revision: number;
  rationale?: string;
}

export interface DecisionProgress<TChosen = string> {
  decisions: readonly DecisionRecord<TChosen>[];
}

/** Match chat input and HTML maxlength: UTF-16 code units, not serialized bytes. */
export const DECISION_RESPONSE_MAX_LENGTH = 64_000;
/** Reserve room for command metadata beneath the route's 256,000-byte body cap. */
export const DECISION_RESPONSE_MAX_BYTES = 192_000;

export function isDecisionResponseWithinLimits(response: {
  chosen?: unknown;
  rationale?: unknown;
}): boolean {
  const fields = [response.chosen, response.rationale].filter(
    (value): value is string => typeof value === 'string',
  );
  return (
    fields.every((value) => value.length <= DECISION_RESPONSE_MAX_LENGTH) &&
    new TextEncoder().encode(JSON.stringify(fields)).length <= DECISION_RESPONSE_MAX_BYTES
  );
}

/** Text responses remain literal even when their text matches an authored option ID. */
export function decisionResponseLabel(
  definition:
    | {
        responseType?: 'choice' | 'text';
        options: readonly { id: string; label: string }[];
      }
    | undefined,
  chosen: string,
): string {
  return definition?.responseType === 'text'
    ? chosen
    : (definition?.options.find((option) => option.id === chosen)?.label ?? chosen);
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
  if (!isDecisionResponseWithinLimits(response)) return false;
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
