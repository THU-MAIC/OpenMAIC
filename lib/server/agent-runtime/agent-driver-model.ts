import type { Api, Model } from '@earendil-works/pi-ai';

import { slotLanguageModel } from '@/lib/server/model-config/llm';
import {
  lookupSlot,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import type { ResolvedModel } from '@/lib/server/resolve-model';

export const AGENT_DRIVER_STAGE = 'maic-agent-driver' as const;
export const UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS = 8_192;
// The agent slot owns the model choice. This adapter only enforces its transport
// contract: no thinking effort of its own and an OpenAI-compatible pi api/dialect. The actual HTTP transport is selected by
// lib/ai/providers.ts.
const OPENAI_PI_APIS = new Set<Api>(['openai-completions', 'openai-responses']);
const DEFAULT_DRIVER_API: Api = 'openai-completions';

export function buildPiDriverModel(
  connection: ResolvedModel,
  configuredApi?: string,
  routeContextWindow?: number,
): Model<Api> {
  if (!configuredApi || !OPENAI_PI_APIS.has(configuredApi)) {
    throw new Error(
      `The agent slot has unsupported pi api/dialect ` +
        `${JSON.stringify(configuredApi)} for model id ${connection.modelId}.`,
    );
  }
  return {
    id: connection.modelId,
    name: connection.modelId,
    api: configuredApi,
    provider: connection.providerId,
    baseUrl: connection.baseUrl ?? '',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Context-window value chain: route operator pin > catalog model window >
    // conservative 128k fallback. The fallback is only an internal estimate
    // used to decide when to compact; it is not sent to the model API. It must
    // stay below the gateway's real request limit so compaction remains
    // reachable before the gateway rejects an oversized prompt.
    contextWindow: routeContextWindow ?? connection.modelInfo?.contextWindow ?? 128_000,
    // Pi requires Model.maxTokens. For known models this is the real catalog
    // output window. For unknown models 8192 is only a deterministic internal
    // compaction reservation; resolveAgentDriverModel deliberately exposes an
    // independent undefined wireMaxOutputTokens so it never becomes an API cap.
    maxTokens: connection.modelInfo?.outputWindow ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  } as Model<Api>;
}

/**
 * Whether tool results may carry image parts for this driver connection.
 *
 * A catalog-declared vision capability always wins, including an explicit
 * false. For models the catalog does not know — every model served through a
 * custom openai-compatible provider has no catalog entry — the OpenAI wire
 * dialects are trusted with images: their APIs accept image parts in tool
 * results, and silently swapping the observations for a placeholder hides the
 * real failure when a model truly cannot take images (the provider's own
 * error surfaces instead). Non-OpenAI dialects stay unknown (undefined),
 * which keeps the upstream default of omitting images.
 */
export function toolImageSupport(
  connection: ResolvedModel,
  api: Api,
): boolean | undefined {
  const declared = connection.modelInfo?.capabilities?.vision;
  if (declared !== undefined) return declared;
  return OPENAI_PI_APIS.has(api) ? true : undefined;
}

/**
 * Resolve the driver through the `agent` slot for `workspaceId` (where an
 * older deployment's translated defaults leave the agent off). The slot requires tool calling; a model the catalogue says lacks it is
 * refused. The transport dialect defaults to openai-completions.
 */
export async function resolveAgentDriverModel(workspaceId: string | null = null): Promise<{
  connection: ResolvedModel;
  piModel: Model<Api>;
  /** Catalog-backed API limit; undefined means omit max_tokens on the wire. */
  wireMaxOutputTokens?: number;
  /** Internal compaction output-space estimate; never used as a conversation API limit. */
  reservedOutputTokens: number;
  /** Tool-result image forwarding; undefined keeps the upstream default of omitting images. */
  supportsToolImages?: boolean;
}> {
  const resolution = await lookupSlot('agent', workspaceId);
  if (resolution.status === 'disabled') throw new SlotDisabledError('agent');
  if (resolution.status === 'unassigned') throw new SlotUnassignedError('agent');
  if (resolution.requirements.some((check) => check.status === 'unmet')) {
    throw new Error(
      `The agent model ${resolution.modelId} does not support tool calling; choose another model for the agent.`,
    );
  }
  // An effort inherited from an ancestor was already dropped by the
  // resolution, and saving refuses one on the slot itself; this backstop only
  // catches a configuration stored before that check existed.
  if (resolution.thinking?.effort !== undefined) {
    throw new Error(
      `The agent slot must not set thinking.effort because ${resolution.modelId} ` +
        `cannot combine reasoning_effort with function tools on this transport. ` +
        `Remove the thinking effort from the agent slot.`,
    );
  }
  const connection = await slotLanguageModel(resolution);
  const api = resolution.api ?? DEFAULT_DRIVER_API;
  const wireMaxOutputTokens = connection.modelInfo?.outputWindow;
  return {
    connection,
    piModel: buildPiDriverModel(connection, api, resolution.contextWindow),
    supportsToolImages: toolImageSupport(connection, api),
    wireMaxOutputTokens,
    reservedOutputTokens: wireMaxOutputTokens ?? UNKNOWN_MODEL_RESERVED_OUTPUT_TOKENS,
  };
}
