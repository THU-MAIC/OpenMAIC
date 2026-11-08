import type { LearningView } from './types';

export type EditBlockReason =
  | 'completed'
  | 'paused'
  | 'stopped'
  | 'testing'
  | 'building'
  | 'agent'
  | 'teaching'
  | 'discussion'
  | 'quiz'
  | 'recap'
  | 'assessment'
  | 'stage'
  | 'planOnly'
  | 'planLocked';
export interface EditAccessContext {
  state: Pick<LearningView['state'], 'status'>;
  stage: LearningView['stage'];
  actions: readonly string[];
  busy: boolean;
  evaluation: { purpose?: string } | null;
}
/** Stage permissions and temporary writer locks are shared by UI and host writes. */
export function projectEditAccess(
  context: EditAccessContext,
  path?: string,
): {
  canEdit: boolean;
  mode: 'plan' | 'code' | null;
  reason: EditBlockReason | null;
} {
  const { state, stage, actions, busy, evaluation } = context;
  const blocked = (reason: EditBlockReason) => ({ canEdit: false, mode: null, reason });
  if (state.status === 'completed') return blocked('completed');
  if (state.status === 'paused') return blocked('paused');
  if (state.status === 'failed') return blocked('stopped');
  if (evaluation)
    return blocked(
      evaluation.purpose === 'compile' || stage.kind === 'produce' ? 'building' : 'testing',
    );
  if (busy) return blocked('agent');
  if (!actions.includes('edit')) {
    if (stage.kind === 'dialogue') return blocked('discussion');
    if (stage.kind === 'mentor_say')
      return blocked(stage.agent === 'discussion' ? 'teaching' : 'recap');
    if (stage.kind === 'check') return blocked(stage.checker === 'quiz' ? 'quiz' : 'assessment');
    return blocked('stage');
  }
  const mode = stage.kind === 'produce' && stage.writes === 'plan' ? 'plan' : 'code';
  if (path && (mode === 'plan' ? path !== 'PLAN.md' : path === 'PLAN.md'))
    return blocked(mode === 'plan' ? 'planOnly' : 'planLocked');
  return { canEdit: true, mode, reason: null };
}
