/**
 * The agents API's wire shape (`/api/agents`), shared by the routes and the
 * browser registry: an agent with its timestamps as ISO strings, and whether
 * it is read-only (the built-in agents are).
 */
import type { AgentConfig } from './types';

export const AGENTS_ENDPOINT = '/api/agents';

export interface AgentView extends Omit<AgentConfig, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
  readOnly: boolean;
}

export function agentView(agent: AgentConfig): AgentView {
  return {
    ...agent,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    readOnly: agent.isDefault,
  };
}

export function agentFromView(view: AgentView): AgentConfig {
  const { readOnly: _readOnly, createdAt, updatedAt, ...agent } = view;
  return { ...agent, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) };
}
