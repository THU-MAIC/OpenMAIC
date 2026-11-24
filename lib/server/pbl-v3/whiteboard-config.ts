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

export const pblWhiteboardLayout =
  'Whiteboard layout: the learner can use a speech bubble beside the tutor avatar, a floating conversation window, or a docked assistant. The active layout is unobserved. The whiteboard can be closed and reopened from the workbench header.';
