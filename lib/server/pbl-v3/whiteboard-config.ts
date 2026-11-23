import 'server-only';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function pblWhiteboardEnabled() {
  return ['true', '1'].includes(process.env.OPENMAIC_PBL_V3_WHITEBOARD ?? '');
}

export function pblWhiteboardTeachingRole(role: string) {
  return ['mentor', 'discussion', 'planner', 'coder'].includes(role);
}

let skill: string | undefined;
export function pblExplanationSkill() {
  return (skill ??= readFileSync(
    path.join(process.cwd(), 'skills/pbl/pbl-explanation/SKILL.md'),
    'utf8',
  )
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .trim());
}

/** The host owns these UI directions; course text and learner quotations stay verbatim. */
export function teachingLayout(board: boolean) {
  if (board)
    return {
      nextControl:
        'the controls beside the movable tutor avatar (initially at the bottom-right of the workbench)',
      progress:
        'Workbench header: milestones. The progress ring around the tutor avatar opens the current task.',
      drawer: 'Open the current task from the progress ring around the tutor avatar.',
      landmark: 'the avatar controls',
      note: 'Whiteboard layout: the reply plays beside the tutor avatar. The learner can reply there, open the conversation from the avatar, or dock it. The current task opens in the conversation window from the avatar progress ring. The pencil in the workbench header reopens the board.',
    };
  return {
    nextControl: 'the task bar at the bottom of the Learning Assistant pane',
    progress:
      'Workbench header: milestones. Task bar at the bottom of the Learning Assistant pane: current milestone steps.',
    drawer:
      'The task drawer opens upward from the visibly labeled Current task button on the task bar at the bottom of the Learning Assistant pane.',
    landmark: 'the task bar and pane',
    note: '',
  };
}
