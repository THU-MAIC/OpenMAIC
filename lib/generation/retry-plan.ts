export type RetryStep =
  | 'pdf-analysis'
  | 'web-search'
  | 'outline'
  | 'agent-generation'
  | 'slide-content'
  | 'actions'
  | 'tts';

const DEPENDENTS: Record<RetryStep, readonly RetryStep[]> = {
  'pdf-analysis': ['web-search', 'outline', 'agent-generation', 'slide-content', 'actions', 'tts'],
  'web-search': ['outline', 'agent-generation', 'slide-content', 'actions', 'tts'],
  outline: ['agent-generation', 'slide-content', 'actions', 'tts'],
  'agent-generation': ['slide-content', 'actions', 'tts'],
  'slide-content': ['actions', 'tts'],
  actions: ['tts'],
  tts: [],
};

/** Returns the minimum suffix that must be regenerated after a step fails. */
export function stepsToRetry(failed: RetryStep, active: readonly RetryStep[]): RetryStep[] {
  const affected = new Set<RetryStep>([failed, ...DEPENDENTS[failed]]);
  return active.filter((step) => affected.has(step));
}

/** These operations must never be automatically replayed after partial output. */
export function isSafeToAutoRetry(step: RetryStep): boolean {
  return step === 'pdf-analysis' || step === 'web-search';
}

export function retrySessionFields(failed: RetryStep): string[] {
  return [...DEPENDENTS[failed], failed];
}

export function completedCheckpointSteps(session: {
  pdfText?: string;
  researchContext?: string;
  sceneOutlines?: unknown[] | null;
  generatedAgents?: unknown[];
  generatedFirstSceneContent?: unknown;
  generatedFirstScene?: unknown;
}): RetryStep[] {
  const result: RetryStep[] = [];
  if (session.pdfText) result.push('pdf-analysis');
  if (session.researchContext) result.push('web-search');
  if (session.sceneOutlines?.length) result.push('outline');
  if (session.generatedAgents?.length) result.push('agent-generation');
  if (session.generatedFirstSceneContent) result.push('slide-content');
  if (session.generatedFirstScene) result.push('actions');
  return result;
}
