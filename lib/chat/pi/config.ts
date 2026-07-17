import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const DEFAULT_PI_MAX_AGENT_TURNS = 6;
const MAX_PI_MAX_AGENT_TURNS = 6;
const DEFAULT_PI_MAX_ACTIONS_PER_AGENT = 8;
const MAX_PI_MAX_ACTIONS_PER_AGENT = 8;

export function resolveAgentConfigs(body: StatelessChatRequest): AgentConfig[] {
  const overrides = new Map<string, AgentConfig>();
  for (const cfg of body.config.agentConfigs ?? []) {
    overrides.set(cfg.id, {
      ...cfg,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const registry = useAgentRegistry.getState();
  return body.config.agentIds
    .map((id) => overrides.get(id) ?? registry.getAgent(id))
    .filter((agent): agent is AgentConfig => Boolean(agent));
}

export function getPiMaxAgentTurns(body: StatelessChatRequest): number {
  return clampPositiveInteger(
    body.config.piMaxAgentTurns,
    DEFAULT_PI_MAX_AGENT_TURNS,
    MAX_PI_MAX_AGENT_TURNS,
  );
}

export function getPiMaxActionsPerAgent(body: StatelessChatRequest): number {
  return clampPositiveInteger(
    body.config.piMaxActionsPerAgent,
    DEFAULT_PI_MAX_ACTIONS_PER_AGENT,
    MAX_PI_MAX_ACTIONS_PER_AGENT,
  );
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}
