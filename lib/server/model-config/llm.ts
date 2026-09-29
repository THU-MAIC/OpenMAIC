/**
 * Language models from slot resolutions (RFC #1701, tracked in #1725).
 *
 * Builds the same `ResolvedModel` the request-header path builds, so call
 * sites keep one shape. A provider from the workspace layer was configured by
 * a user, so its endpoint is checked like a caller-supplied one and the
 * transport refuses redirects; deployment and default providers keep the
 * operator transport, which re-validates every redirect hop.
 */
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
  const registered = getProvider(registryId);
  if (!registered) throw new Error(`The ${target.presetId} preset has no chat adapter`);
  const userEndpoint = target.providerSource === 'workspace';
  const endpoint = target.baseUrl ?? registered.defaultBaseUrl;
  if (userEndpoint && endpoint) {
    const problem = await validateClientBaseUrl(endpoint);
    if (problem) throw new Error(problem);
  }
  const apiKey = target.apiKey ?? '';
  const { model, modelInfo } = getModel({
    providerId: registryId,
    modelId: target.modelId,
    apiKey,
    baseUrl: target.baseUrl,
    proxy: target.proxy,
    fetchImpl: userEndpoint ? clientBaseUrlLlmFetch : fetchWithRedirectValidation,
  });
  return {
    model,
    modelInfo,
    modelString: `${registryId}:${target.modelId}`,
    providerId: registryId,
    modelId: target.modelId,
    apiKey,
    baseUrl: target.baseUrl,
    thinkingConfig,
    // The configuration is the server's, whoever edited it: the slot's own
    // fallback may be tried.
    serverManaged: true,
  };
}

export async function slotLanguageModel(resolution: AssignedSlot): Promise<SlotResolvedModel> {
  return { ...(await languageModelFor(resolution, resolution.thinking)), resolution };
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
