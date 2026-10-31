import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

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
