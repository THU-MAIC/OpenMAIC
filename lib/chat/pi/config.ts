import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const DEFAULT_PI_MAX_AGENT_TURNS = 6;
const MAX_PI_MAX_AGENT_TURNS = 6;
const DEFAULT_PI_MAX_ACTIONS_PER_AGENT = 8;
const MAX_PI_MAX_ACTIONS_PER_AGENT = 8;
// A single Native Child turn may legitimately interleave whiteboard reads,
// draws, and corrective calls. Keep the ceiling generous enough for that work
// while still bounding a runaway child; deployments can tune both values.
const DEFAULT_PI_NATIVE_CHILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PI_NATIVE_CHILD_MAX_PROVIDER_TRANSPORTS = 100;

/** Node.js clamps `setTimeout` delays above this value to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Extra time the enclosing `call_agent` bound allows after the Native Child deadline. */
export const CALL_AGENT_TIMEOUT_MARGIN_MS = 30_000;

/**
 * The Native Child budget must leave room for the enclosing tool wrapper's
 * margin while staying inside Node's supported timer range.
 */
export const MAX_PI_NATIVE_CHILD_TIMEOUT_MS = MAX_TIMER_DELAY_MS - CALL_AGENT_TIMEOUT_MARGIN_MS;

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

export function getPiNativeChildTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(
    positiveIntegerFromEnv(
      env,
      'OPENMAIC_PI_NATIVE_CHILD_TIMEOUT_MS',
      DEFAULT_PI_NATIVE_CHILD_TIMEOUT_MS,
    ),
    MAX_PI_NATIVE_CHILD_TIMEOUT_MS,
  );
}

export function getPiNativeChildMaxProviderTransports(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveIntegerFromEnv(
    env,
    'OPENMAIC_PI_NATIVE_CHILD_MAX_PROVIDER_TRANSPORTS',
    DEFAULT_PI_NATIVE_CHILD_MAX_PROVIDER_TRANSPORTS,
  );
}

function positiveIntegerFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}
