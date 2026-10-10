/**
 * The browser's client for the agents API (`/api/agents`): the owner's
 * custom agents live on the server, built-in agents in code. Used by the
 * registry store (`./store.ts`); nothing here keeps state.
 */
import type { CustomAgent, CustomAgentFields } from './schema';
import type { AgentConfig } from './types';
import { AGENTS_ENDPOINT, agentFromView, type AgentView } from './wire';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A refusal of the agents API, with its status and code. */
export class AgentRegistryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentRegistryRequestError';
  }
}

async function failure(response: Response, what: string): Promise<AgentRegistryRequestError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown };
  } | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
  const message =
    typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
  return new AgentRegistryRequestError(`${what}: ${message}`, response.status, code);
}

const defaultFetch: Fetch = (input, init) => fetch(input, init);

const agentPath = (id: string) => `${AGENTS_ENDPOINT}/${encodeURIComponent(id)}`;

/** The owner's custom agents (the built-in ones come from code). */
export async function fetchCustomAgents(fetchImpl: Fetch = defaultFetch): Promise<AgentConfig[]> {
  const response = await fetchImpl(AGENTS_ENDPOINT, { cache: 'no-store' });
  if (!response.ok) throw await failure(response, 'list agents');
  const body = (await response.json()) as { agents?: AgentView[] };
  return (body.agents ?? []).filter((view) => !view.readOnly).map(agentFromView);
}

async function agentAnswer(response: Response, what: string): Promise<AgentConfig> {
  if (!response.ok) throw await failure(response, what);
  return agentFromView(((await response.json()) as { agent: AgentView }).agent);
}

export async function createCustomAgent(
  agent: CustomAgent,
  fetchImpl: Fetch = defaultFetch,
): Promise<AgentConfig> {
  const response = await fetchImpl(AGENTS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
  return agentAnswer(response, 'create agent');
}

export async function updateCustomAgent(
  id: string,
  fields: CustomAgentFields,
  fetchImpl: Fetch = defaultFetch,
): Promise<AgentConfig> {
  const response = await fetchImpl(agentPath(id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: fields }),
  });
  return agentAnswer(response, 'update agent');
}

/** Delete a custom agent; one that is already gone counts as deleted. */
export async function deleteCustomAgent(
  id: string,
  fetchImpl: Fetch = defaultFetch,
): Promise<void> {
  const response = await fetchImpl(agentPath(id), { method: 'DELETE' });
  if (response.ok || response.status === 404) return;
  throw await failure(response, 'delete agent');
}
