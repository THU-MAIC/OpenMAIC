import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentRole } from './domain/project/project-schema';

/** Who the learner sees speaking in each role: a face and a name key under `pblV3.personas`. */
export const ROLE_PERSONAS: Record<AgentRole, { avatar: string; color: string }> = {
  mentor: { avatar: '/avatars/teacher.png', color: '#7c3aed' },
  discussion: { avatar: '/avatars/curious.png', color: '#0284c7' },
  planner: { avatar: '/avatars/thinker.png', color: '#059669' },
  coder: { avatar: '/avatars/note-taker.png', color: '#d97706' },
};

const EPOCH = new Date(0);
export const PBL_NARRATORS: AgentConfig[] = Object.entries(ROLE_PERSONAS).map(
  ([role, persona], index) => ({
    id: role,
    name: role,
    // Each PBL role teaches. Use the platform narrator voice for all four.
    role: 'teacher',
    persona: '',
    avatar: persona.avatar,
    color: persona.color,
    allowedActions: [],
    priority: 10 - index,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    isDefault: true,
  }),
);
