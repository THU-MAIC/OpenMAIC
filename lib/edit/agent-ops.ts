import { produce } from 'immer';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { AGENT_DEFAULT_AVATARS, AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';

// Cap undo history so long editing sessions don't grow memory unbounded.
export const MAX_HISTORY = 50;

export type AgentRoster = GeneratedAgentConfig[];

export interface AgentConfigPatch {
  name?: string;
  role?: string;
  persona?: string;
  avatar?: string;
}

export type AgentEditOperation =
  | { type: 'agent.add'; agent: GeneratedAgentConfig }
  | { type: 'agent.update'; id: string; patch: AgentConfigPatch }
  | { type: 'agent.delete'; id: string }
  | { type: 'agent.reorder'; id: string; index: number };

export interface AgentRosterHistory {
  past: AgentRoster[];
  present: AgentRoster;
  future: AgentRoster[];
}

/** Maps a role string to its priority number. teacher=10, assistant=7, else=5. */
export function priorityForRole(role: string): number {
  if (role === 'teacher') return 10;
  if (role === 'assistant') return 7;
  return 5;
}

/** Returns a sensible display name for a role. */
function nameForRole(role: string): string {
  if (role === 'teacher') return 'Teacher';
  if (role === 'assistant') return 'Assistant';
  return 'Student';
}

/**
 * Build a new GeneratedAgentConfig with defaults derived from role + index.
 * avatar cycles through AGENT_DEFAULT_AVATARS, color through AGENT_COLOR_PALETTE.
 */
export function createAgentConfig(role: string, index: number, id: string): GeneratedAgentConfig {
  return {
    id,
    name: nameForRole(role),
    role,
    persona: '',
    avatar: AGENT_DEFAULT_AVATARS[index % AGENT_DEFAULT_AVATARS.length],
    color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
    priority: priorityForRole(role),
  };
}

/** Count how many agents in the roster have role 'teacher'. */
export function teacherCount(roster: AgentRoster): number {
  return roster.filter((a) => a.role === 'teacher').length;
}

export function applyAgentEditOperation(roster: AgentRoster, op: AgentEditOperation): AgentRoster;
export function applyAgentEditOperation(
  history: AgentRosterHistory,
  op: AgentEditOperation,
): AgentRosterHistory;
export function applyAgentEditOperation(
  target: AgentRoster | AgentRosterHistory,
  op: AgentEditOperation,
): AgentRoster | AgentRosterHistory {
  if (isAgentRosterHistory(target)) {
    const next = applyOperationToRoster(target.present, op);
    // If the roster didn't change (e.g. update against missing id), skip history push.
    if (next === target.present) return target;

    return {
      past: capHistory([...target.past, target.present]),
      present: next,
      future: [],
    };
  }

  return applyOperationToRoster(target, op);
}

export function undoAgentEditOperation(h: AgentRosterHistory): AgentRosterHistory {
  if (h.past.length === 0) return h;

  const previous = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redoAgentEditOperation(h: AgentRosterHistory): AgentRosterHistory {
  if (h.future.length === 0) return h;

  const next = h.future[0];
  return {
    past: capHistory([...h.past, h.present]),
    present: next,
    future: h.future.slice(1),
  };
}

function applyOperationToRoster(roster: AgentRoster, op: AgentEditOperation): AgentRoster {
  return produce(roster, (draft) => {
    switch (op.type) {
      case 'agent.add': {
        draft.push({ ...op.agent });
        return;
      }
      case 'agent.update': {
        const agent = draft.find((a) => a.id === op.id);
        if (!agent) return;

        // Guard: role change that would drop teacher count to 0.
        if (op.patch.role !== undefined && op.patch.role !== agent.role) {
          if (agent.role === 'teacher' && teacherCount(roster) <= 1) {
            throw new Error('LAST_TEACHER');
          }
        }

        Object.assign(agent, op.patch);

        // Recompute priority when role changes.
        if (op.patch.role !== undefined) {
          agent.priority = priorityForRole(agent.role);
        }
        return;
      }
      case 'agent.delete': {
        const idx = draft.findIndex((a) => a.id === op.id);
        if (idx === -1) return;
        const agent = draft[idx];

        // Guard: cannot delete the last teacher.
        if (agent.role === 'teacher' && teacherCount(roster) <= 1) {
          throw new Error('LAST_TEACHER');
        }

        draft.splice(idx, 1);
        return;
      }
      case 'agent.reorder': {
        const currentIndex = draft.findIndex((a) => a.id === op.id);
        if (currentIndex === -1) return;

        const [agent] = draft.splice(currentIndex, 1);
        const nextIndex = Math.max(0, Math.min(op.index, draft.length));
        draft.splice(nextIndex, 0, agent);
        return;
      }
    }
  });
}

function isAgentRosterHistory(
  target: AgentRoster | AgentRosterHistory,
): target is AgentRosterHistory {
  return 'present' in target && 'past' in target && 'future' in target;
}

function capHistory(past: AgentRoster[]): AgentRoster[] {
  return past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past;
}
