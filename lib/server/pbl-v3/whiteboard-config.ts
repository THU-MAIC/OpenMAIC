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

/**
 * The product guide describes the docked assistant pane. With the whiteboard on, the same
 * controls sit beside the tutor avatar, so directions given to the learner must say so.
 */
export function pblWhiteboardProductWording(text: string, withLayoutNote = false) {
  return (
    text
      .replaceAll(
        'Task bar at the bottom of the Learning Assistant pane',
        'Controls beside the tutor avatar at the bottom-right corner of the workbench',
      )
      .replaceAll(
        'the task bar at the bottom of the Learning Assistant pane',
        'the controls beside the tutor avatar at the bottom-right corner of the workbench',
      )
      .replaceAll(
        'The task drawer opens upward from the visibly labeled Current task button on',
        'The task drawer opens in the conversation window, reached from the progress ring around the tutor avatar, among',
      ) +
    (withLayoutNote
      ? '\nWhiteboard layout: your reply appears as a speech bubble above the tutor avatar at the bottom-right corner. The learner types or speaks back in the input under that bubble, and the single next-step or Run tests button sits beside the avatar; clicking the avatar opens the full conversation. The whiteboard is a movable window over the workbench that the learner can close and reopen from the pencil button in the workbench header. There is no Learning Assistant pane unless the learner docks the conversation.'
      : '')
  );
}
