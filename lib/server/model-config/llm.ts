/**
 * Language models from slot resolutions (RFC #1701, tracked in #1725).
 *
 * Builds the same `ResolvedModel` the request-header path builds, so call
 * sites keep one shape. A provider from the workspace layer was configured by
 * a user, so its endpoint is checked like a caller-supplied one and the
 * transport refuses redirects; deployment and default providers keep the
 * operator transport, which re-validates every redirect hop.
 */
import { attachModelFallback } from '@/lib/ai/model-fallbacks';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { getModel, getProvider } from '@/lib/ai/providers';
import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';
import { clientBaseUrlLlmFetch } from '@/lib/server/llm-provider-fetch';
import type { LlmStage } from '@/lib/server/model-routes';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import type { ProviderId, ThinkingConfig } from '@/lib/types/provider';

import type { ResolvedModelTarget, SlotResolution } from './resolve-slot';
import { lookupStage, SlotDisabledError, SlotUnassignedError } from './runtime';

export type AssignedSlot = Extract<SlotResolution, { status: 'assigned' }>;

export interface SlotResolvedModel extends ResolvedModel {
  /** The resolution this model came from; its `fallback` is the retry model. */
  resolution: AssignedSlot;
}

/** A language model for one target (a slot's model or its fallback). */
export async function languageModelFor(
  target: ResolvedModelTarget,
  thinkingConfig?: ThinkingConfig,
): Promise<ResolvedModel> {
  const registryId = target.registryId as ProviderId;
  const modelId = target.modelId;
  // resolveSlot refuses a chat reference without one; this is the type's guard.
  if (!modelId) throw new Error(`A chat model needs "providerId:modelId"`);
  const registered = getProvider(registryId);
  if (!registered) throw new Error(`The ${target.presetId} preset has no chat adapter`);
  const userEndpoint = target.providerSource === 'workspace';
  if (userEndpoint) {
    // Bedrock signs with the server's AWS credential chain when it has no key
    // of its own, and a proxy would route around the transport below: neither
    // is something a workspace may set.
    if (registered.type === 'bedrock') {
      throw new Error('Amazon Bedrock can only be configured by the deployment (openmaic.yml)');
    }
    if (target.proxy) {
      throw new Error('A proxy can only be configured by the deployment (openmaic.yml)');
    }
  }
  const endpoint = target.baseUrl ?? registered.defaultBaseUrl;
  if (userEndpoint && endpoint) {
    const problem = await validateClientBaseUrl(endpoint);
    if (problem) throw new Error(problem);
  }
  const apiKey = target.apiKey ?? '';
  // A self-hosted OpenAI-compatible server usually takes no key: its preset
  // says so, while the registry entry it rides on (OpenAI's) asks for one.
  // Every other preset keeps the registry's rule, so OpenAI itself still
  // needs a key.
  const keyOptional = getProviderPreset(target.presetId)?.apiKeyOptional === true;
  const { model, modelInfo } = getModel({
    providerId: registryId,
    modelId,
    apiKey,
    ...(keyOptional ? { requiresApiKey: false } : {}),
    baseUrl: target.baseUrl,
    proxy: target.proxy,
    fetchImpl: userEndpoint ? clientBaseUrlLlmFetch : fetchWithRedirectValidation,
  });
  return {
    model,
    modelInfo,
    modelString: `${registryId}:${modelId}`,
    providerId: registryId,
    modelId,
    apiKey,
    baseUrl: target.baseUrl,
    thinkingConfig,
    // The configuration is the server's, whoever edited it: the slot's own
    // fallback may be tried.
    serverManaged: true,
  };
}

export class SlotRequirementError extends Error {
  constructor(
    readonly slot: string,
    readonly requirement: string,
  ) {
    super(
      `The model assigned to ${slot} does not meet its requirement (${requirement}); choose another model for it.`,
    );
    this.name = 'SlotRequirementError';
  }
}

export async function slotLanguageModel(resolution: AssignedSlot): Promise<SlotResolvedModel> {
  // Only a requirement the catalogue says is unmet refuses; unknown models pass.
  const unmet = resolution.requirements.find((check) => check.status === 'unmet');
  if (unmet) throw new SlotRequirementError(resolution.slot, unmet.requirement);
  const resolved = await languageModelFor(resolution, resolution.thinking);
  // Retries go to the slot's fallback and nowhere else: none attached means none.
  const { fallback } = resolution;
  const fallbackUnmet = resolution.fallbackRequirements?.some((check) => check.status === 'unmet');
  attachModelFallback(resolved.model, async () => {
    // A retry on a model that cannot do what the slot needs would only fail again.
    if (!fallback || fallbackUnmet) return null;
    const built = await languageModelFor(fallback, resolution.thinking);
    return { model: built.model, modelString: built.modelString };
  });
  return { ...resolved, resolution };
}

export interface StageModelOptions {
  stage: LlmStage;
  workspaceId: string | null;
  /**
   * What the request still names the old way (x-model and friends), or
   * undefined when it names nothing. Consulted only when the configuration
   * leaves the slot unassigned.
   */
  legacyRequest?: () => Promise<ResolvedModel | undefined>;
}

/**
 * The model for a stage: the configured slot, else the model the request
 * names (deprecated), else the legacy defaults. Fails loudly when the slot is
 * turned off or nothing resolves.
 */
export async function resolveStageModel({
  stage,
  workspaceId,
  legacyRequest,
}: StageModelOptions): Promise<ResolvedModel> {
  const lookup = await lookupStage(stage, workspaceId);
  const { configured } = lookup;
  if (configured.status === 'assigned') return slotLanguageModel(configured);
  if (configured.status === 'disabled') throw new SlotDisabledError(configured.slot);
  const requested = await legacyRequest?.();
  if (requested) return requested;
  const fallback = lookup.defaults();
  if (fallback.status === 'assigned') return slotLanguageModel(fallback);
  if (fallback.status === 'disabled') throw new SlotDisabledError(fallback.slot);
  throw new SlotUnassignedError(configured.slot);
}
