import type { ArtifactRef } from '../project/project-schema';
import type { DecisionRecord } from './decisions';

export interface DecisionQuestion {
  id: string;
  desc?: string;
  decisionPrompt?: string;
  options?: readonly unknown[];
  responseType?: 'choice' | 'text';
  requiresRationale?: boolean;
}

export interface ArtifactMilestone {
  contract?: string;
  decisions?: readonly string[];
}

export interface ArtifactState {
  decisions?: readonly DecisionRecord[];
  plan?: string;
  code?: string;
}

export interface ArtifactProjectionInput {
  reads: readonly ArtifactRef[];
  milestone: ArtifactMilestone;
  state: ArtifactState;
  decisionCatalog: readonly DecisionQuestion[];
}

export interface ArtifactProjection {
  contract?: string;
  decisions?: readonly {
    id: string;
    desc?: string;
    prompt?: string;
    options?: readonly unknown[];
    responseType?: 'choice' | 'text';
    requiresRationale?: boolean;
  }[];
  decisionsChosen?: readonly (Pick<DecisionRecord, 'id' | 'chosen' | 'rationale'> & {
    selection?: { label: string; summary?: string };
  })[];
  plan?: string;
  code?: string;
}

export function projectArtifacts({
  reads,
  milestone,
  state,
  decisionCatalog,
}: ArtifactProjectionInput): ArtifactProjection {
  const projection: ArtifactProjection = {};

  for (const artifact of reads) {
    if (artifact === 'contract') projection.contract = milestone.contract ?? '';
    if (artifact === 'decisions') {
      projection.decisions = (milestone.decisions ?? []).map((decisionId) => {
        const definition = decisionCatalog.find((decision) => decision.id === decisionId);
        if (!definition) return { id: decisionId };
        return {
          id: definition.id,
          ...(definition.desc === undefined ? {} : { desc: definition.desc }),
          ...(definition.decisionPrompt === undefined ? {} : { prompt: definition.decisionPrompt }),
          ...(definition.options === undefined ? {} : { options: definition.options }),
          ...(definition.responseType === undefined
            ? {}
            : { responseType: definition.responseType }),
          ...(definition.requiresRationale === undefined
            ? {}
            : { requiresRationale: definition.requiresRationale }),
        };
      });
    }
    if (artifact === 'decisions.chosen') {
      projection.decisionsChosen = (state.decisions ?? []).map(({ id, chosen, rationale }) => ({
        id,
        chosen,
        ...(rationale === undefined ? {} : { rationale }),
        ...selectedOption(decisionCatalog, id, chosen),
      }));
    }
    if (artifact === 'plan') projection.plan = state.plan ?? '';
    if (artifact === 'code') projection.code = state.code ?? '';
  }

  return projection;
}

/** Public option semantics travel with the saved ID; private rubric never does. */
function selectedOption(catalog: readonly DecisionQuestion[], id: string, chosen: unknown) {
  const question = catalog.find((item) => item.id === id);
  if (question?.responseType === 'text') return {};
  const option = question?.options?.find(
    (value) => typeof value === 'object' && value !== null && 'id' in value && value.id === chosen,
  );
  if (
    !option ||
    typeof option !== 'object' ||
    !('label' in option) ||
    typeof option.label !== 'string'
  )
    return {};
  return {
    selection: {
      label: option.label,
      ...('summary' in option && typeof option.summary === 'string'
        ? { summary: option.summary }
        : {}),
    },
  };
}
