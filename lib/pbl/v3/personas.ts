import type { AgentRole } from './domain/project/project-schema';

/** Who the learner sees speaking in each role: a face and a name key under `pblV3.personas`. */
export const ROLE_PERSONAS: Record<AgentRole, { avatar: string; color: string }> = {
  mentor: { avatar: '/avatars/teacher.png', color: '#7c3aed' },
  discussion: { avatar: '/avatars/curious.png', color: '#0284c7' },
  planner: { avatar: '/avatars/thinker.png', color: '#059669' },
  coder: { avatar: '/avatars/note-taker.png', color: '#d97706' },
};
