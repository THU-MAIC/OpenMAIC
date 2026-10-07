/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import { getModel, getProvider, parseModelString, type ModelWithInfo } from '@/lib/ai/providers';
import type { ProviderType, ThinkingConfig } from '@/lib/types/provider';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  resolveProxy,
} from '@/lib/server/provider-config';
import { validateClientBaseUrl, validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';
import { clientBaseUrlLlmFetch } from '@/lib/server/llm-provider-fetch';
import {
  getUserStageRoute,
  parseUserStageRoutes,
  type LlmStage,
  type UserStageRoute,
} from '@/lib/server/model-routes';

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
  /** Resolved provider ID (e.g. "openai", "ollama") */
  providerId: string;
  /** Resolved model ID (e.g. "gpt-4o-mini") */
  modelId: string;
  /** Effective API key after server-side fallback resolution */
  apiKey: string;
  /** Effective base URL after server/client resolution */
  baseUrl?: string;
  /** Optional per-request thinking configuration from the client. */
  thinkingConfig?: ThinkingConfig;
  /**
   * Whether the primary comes from server configuration: a capability slot, or
   * (on the deprecated request path) a server-configured provider. A model and
   * key the client sent are not. Only server-managed primaries may arm the
   * retryable-failure fallback in callLLM: a client-supplied model with a
   * garbage key must never be allowed to burn the operator's fallback key.
   * Callers pass this through to callLLM's `fallbackOptions.serverManaged`.
   */
  serverManaged: boolean;
}

export interface ModelRequest {
  modelString?: string;
  /**
   * The generation stage (a `callLLM` source label, e.g. 'scene-content'). A
   * stage resolves through its capability slot (lib/config/model-slots.ts):
   * the deployment and workspace configuration first; the model the request
   * names only when the configuration leaves the slot unassigned; then the
   * defaults an older deployment set with DEFAULT_MODEL.
   */
  stage?: LlmStage;
  /** Whose web settings apply; null for none. */
  workspaceId?: string | null;
  /**
   * User-level per-stage routes (the browser's `x-model-routes`), deprecated
   * with the other request fields. A user route carries its own connection
   * params (apiKey/baseUrl/providerType) for the routed provider;
   * server-managed providers still resolve credentials authoritatively.
   */
  userRoutes?: Record<string, UserStageRoute>;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  thinkingConfig?: ThinkingConfig;
}

let deprecationLogged = false;

/** Why a request's own model is refused under `allowUserKeys: false`. */
export const REQUEST_PROVIDERS_REFUSED =
  'This server uses only the providers its configuration declares; a request cannot name its own model, key or endpoint.';

/**
 * Resolve a language model: through the stage's slot when there is a stage,
 * else (verify-model) the model the request names. Fails loudly when nothing
 * resolves; there is no vendor default.
 */
export async function resolveModel(params: ModelRequest): Promise<ResolvedModel> {
  const { requestProvidersAllowed } = await import('@/lib/server/model-config/runtime');
  // Under `allowUserKeys: false` users choose only among the
  // providers openmaic.yml declares: the model, key and endpoint a request
  // names are ignored, and only the configuration decides.
  const allowed = requestProvidersAllowed();
  if (params.stage) {
    const { resolveStageModel } = await import('@/lib/server/model-config/llm');
    return resolveStageModel({
      stage: params.stage,
      workspaceId: params.workspaceId ?? null,
      ...(allowed ? { legacyRequest: () => resolveRequestedModel(params) } : {}),
    });
  }
  if (!allowed) throw new Error(REQUEST_PROVIDERS_REFUSED);
  const requested = await resolveRequestedModel(params);
  if (!requested) throw new Error('No model could be resolved: the request names none.');
  return requested;
}

/**
 * The model a request names with its own fields (x-model, x-api-key,
 * x-base-url, x-provider-type, x-model-routes, or the equivalent body
 * fields), or undefined when it names none. Deprecated: the configuration
 * decides, and this answers only for a slot it leaves unassigned, and never
 * under `allowUserKeys: false` (see resolveModel).
 */
export async function resolveRequestedModel(
  params: ModelRequest,
): Promise<ResolvedModel | undefined> {
  const userRoute = getUserStageRoute(params.userRoutes ?? {}, params.stage);
  const stageModel = userRoute?.model;
  const modelString = stageModel || params.modelString;
  if (!modelString) return undefined;
  if (!deprecationLogged) {
    deprecationLogged = true;
    console.warn(
      '[resolve-model] A request named its own model or key. This is deprecated: configure models in the model settings or openmaic.yml.',
    );
  }
  const { providerId, modelId } = parseModelString(modelString);

  // When a stage route overrides the client's model, the client-sent connection
  // params (apiKey/baseUrl/providerType) belong to the client's *other* model
  // and must not bleed onto the routed provider — otherwise e.g. a routed
  // Anthropic model would be built with the client's OpenAI providerType/key.
  // A routed model resolves purely from server config, as if no x-model was sent
  // — except a *user* route, which supplies its own connection for the routed
  // provider (server-managed providers ignore it regardless).
  const routed = Boolean(stageModel);
  const clientApiKey = routed ? userRoute?.apiKey : params.apiKey;
  const clientProviderType = routed ? userRoute?.providerType : params.providerType;
  const clientBaseUrlParam = routed ? userRoute?.baseUrl : params.baseUrl;

  // Server-managed providers are admin-owned: the operator's key and base URL
  // are authoritative and any client-sent override is ignored. Origin URL
  // validation therefore applies only to unmanaged providers, where the base
  // URL really is client-supplied. (Server-configured URLs are trusted by the
  // operator.) Every provider fetch still runs through a transport that
  // re-validates redirect hops: no upstream can be assumed to redirect only to
  // public targets, so the hop target is checked regardless of who chose the
  // origin.
  const managed = isServerConfiguredProvider('providers', providerId);
  const registeredProviderType = getProvider(providerId)?.type;
  if (
    clientProviderType &&
    registeredProviderType &&
    clientProviderType !== registeredProviderType
  ) {
    throw new Error(
      `Provider type mismatch for ${providerId}: expected ${registeredProviderType}, received ${clientProviderType}.`,
    );
  }
  const effectiveProviderType = (clientProviderType || registeredProviderType) as
    | ProviderType
    | undefined;
  if (effectiveProviderType === 'bedrock' && (providerId !== 'bedrock' || !managed)) {
    throw new Error('Amazon Bedrock must be enabled by the server operator before it can be used.');
  }
  const clientBaseUrl = managed ? undefined : clientBaseUrlParam || undefined;
  // The caller picked this model, so an unmanaged provider's endpoint is the
  // caller's choice: the client-supplied URL or the provider's catalog default
  // (e.g. a localhost Ollama).
  const clientEndpoint = !managed;
  const endpointUrl = clientBaseUrl ?? getProvider(providerId)?.defaultBaseUrl;
  if (clientEndpoint && endpointUrl) {
    const ssrfError = clientBaseUrl
      ? await validateClientBaseUrl(clientBaseUrl)
      : await validateUrlForSSRF(endpointUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  const apiKey = resolveApiKey(providerId, clientApiKey || '');
  const baseUrl = resolveBaseUrl(providerId, clientBaseUrl);
  const proxy = resolveProxy(providerId);
  const { model, modelInfo } = getModel({
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    providerType: clientProviderType as ProviderType | undefined,
    // A caller-chosen endpoint is pinned and refuses redirects (see
    // lib/server/llm-provider-fetch.ts). Operator-configured endpoints keep the
    // transport that re-validates every redirect hop.
    fetchImpl: clientEndpoint ? clientBaseUrlLlmFetch : fetchWithRedirectValidation,
  });

  // A user route carries its own ThinkingConfig; the client's thinking belongs
  // to its main model, so a routed stage drops it.
  const thinkingConfig: ThinkingConfig | undefined = routed
    ? userRoute?.thinking
    : params.thinkingConfig;

  return {
    model,
    modelInfo,
    modelString,
    providerId,
    modelId,
    apiKey,
    baseUrl,
    thinkingConfig,
    // A server-configured provider key is operator-owned, so the primary may
    // arm the operator's fallback. A client model on an unmanaged provider,
    // with a key the client sent, must not.
    serverManaged: managed,
  };
}

function getThinkingConfigFromBody(body: unknown): ThinkingConfig | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { thinkingConfig?: unknown; thinking?: unknown };
  const config = record.thinkingConfig ?? record.thinking;
  return config && typeof config === 'object' ? (config as ThinkingConfig) : undefined;
}

/**
 * Resolve a language model from standard request headers.
 *
 * Reads: x-model, x-api-key, x-base-url, x-provider-type, x-model-routes
 * Note: requiresApiKey is derived server-side from the provider registry,
 * never from client headers, to prevent auth bypass.
 */
export async function resolveModelFromHeaders(
  req: NextRequest,
  stage?: LlmStage,
  thinkingConfig?: ThinkingConfig,
): Promise<ResolvedModel> {
  const { requestWorkspaceId } = await import('@/lib/server/model-config/runtime');
  return resolveModel({
    workspaceId: stage ? await requestWorkspaceId(req) : null,
    modelString: req.headers.get('x-model') || undefined,
    stage,
    userRoutes: parseUserStageRoutes(req.headers.get('x-model-routes')),
    apiKey: req.headers.get('x-api-key') || undefined,
    baseUrl: req.headers.get('x-base-url') || undefined,
    providerType: req.headers.get('x-provider-type') || undefined,
    thinkingConfig,
  });
}

/**
 * Resolve a language model from standard request headers plus body fields.
 *
 * Reads model credentials from headers and per-request thinking config from
 * the JSON body field `thinkingConfig` (or legacy/eval field `thinking`).
 */
export async function resolveModelFromRequest(
  req: NextRequest,
  body: unknown,
  stage?: LlmStage,
): Promise<ResolvedModel> {
  // Pass the client's body thinking into resolveModel so the single arbiter
  // there decides (a routed stage may override or drop it). See resolveModel.
  return resolveModelFromHeaders(req, stage, getThinkingConfigFromBody(body));
}
