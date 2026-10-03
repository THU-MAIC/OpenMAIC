/**
 * Which of the generation preview's steps a run is at. The preview shows the
 * classic steps (material analysis, web search, outline, roles, page content,
 * teaching actions); the run reports its own step ids (`material-analysis`,
 * `research`, `outline`, `agents`, `scene:<n>:content|actions|narration`).
 */
import type { RunView } from './types';

export type PreviewStepId =
  | 'pdf-analysis'
  | 'web-search'
  | 'outline'
  | 'agent-generation'
  | 'slide-content'
  | 'actions';

/**
 * Whether the preview lists the material analysis: materials are extracted
 * since their upload, so only while the run waits for an extraction (it then
 * names the kinds of material it waits on) and until they are analyzed.
 */
export function showsMaterialAnalysis(
  view: Pick<RunView, 'input' | 'materialKinds' | 'materialsAnalyzed'>,
): boolean {
  return (
    view.input.materialIds.length > 0 && view.materialKinds !== null && !view.materialsAnalyzed
  );
}

/** The steps the preview lists for a run, in order. */
export function previewStepIds(input: {
  hasMaterials: boolean;
  webSearch: boolean;
  autoAgents: boolean;
}): PreviewStepId[] {
  return [
    ...(input.hasMaterials ? (['pdf-analysis'] as const) : []),
    ...(input.webSearch ? (['web-search'] as const) : []),
    'outline',
    ...(input.autoAgents ? (['agent-generation'] as const) : []),
    'slide-content',
    'actions',
  ];
}

function stepOfRun(view: Pick<RunView, 'state' | 'step'>): PreviewStepId {
  const step = view.step;
  if (view.state === 'awaiting_outline_confirmation') return 'outline';
  if (step === 'material-analysis') return 'pdf-analysis';
  if (step === 'research') return 'web-search';
  if (step === 'outline') return 'outline';
  if (step === 'agents') return 'agent-generation';
  const scene = step ? /^scene:\d+:(content|actions|narration)$/.exec(step) : null;
  if (scene) return scene[1] === 'content' ? 'slide-content' : 'actions';
  // Between steps: where the run goes next.
  if (view.state === 'preparing') return 'pdf-analysis';
  if (view.state === 'outlining') return 'outline';
  return 'agent-generation';
}

/** The index in `steps` of the step the run is at (a step the preview does not list counts as the next one). */
export function previewStepIndex(
  view: Pick<RunView, 'state' | 'step'>,
  steps: readonly string[],
): number {
  const order: PreviewStepId[] = [
    'pdf-analysis',
    'web-search',
    'outline',
    'agent-generation',
    'slide-content',
    'actions',
  ];
  const at = order.indexOf(stepOfRun(view));
  for (let rank = at; rank < order.length; rank += 1) {
    const index = steps.indexOf(order[rank]!);
    if (index >= 0) return index;
  }
  return Math.max(0, steps.length - 1);
}
