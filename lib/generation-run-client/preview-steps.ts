/**
 * Which of the generation preview's steps a run is at. The preview shows the
 * classic steps (web search, outline, roles, page content, teaching actions);
 * the run reports its own step ids (`material-analysis`, `research`,
 * `outline`, `agents`, `scene:<n>:content|actions|narration`).
 *
 * The material analysis is not a preview step: materials are extracted since
 * their upload, and the run's step only reads (or waits for) that extraction.
 * While it runs, the preview shows the step that comes next; a failure of it
 * pauses the run like any other step's.
 */
import type { RunView } from './types';

export type PreviewStepId =
  | 'web-search'
  | 'outline'
  | 'agent-generation'
  | 'slide-content'
  | 'actions';

/** The steps the preview lists for a run, in order. */
export function previewStepIds(input: {
  webSearch: boolean;
  autoAgents: boolean;
}): PreviewStepId[] {
  return [
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
  // The material analysis (running, or paused at a failure) shows as the step after it.
  if (step === 'material-analysis' || step === 'research') return 'web-search';
  if (step === 'outline') return 'outline';
  if (step === 'agents') return 'agent-generation';
  const scene = step ? /^scene:\d+:(content|actions|narration)$/.exec(step) : null;
  if (scene) return scene[1] === 'content' ? 'slide-content' : 'actions';
  // Between steps: where the run goes next.
  if (view.state === 'preparing') return 'web-search';
  if (view.state === 'outlining') return 'outline';
  return 'agent-generation';
}

/** The index in `steps` of the step the run is at (a step the preview does not list counts as the next one). */
export function previewStepIndex(
  view: Pick<RunView, 'state' | 'step'>,
  steps: readonly string[],
): number {
  const order: PreviewStepId[] = [
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
