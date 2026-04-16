/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import {
  getModel,
  isProviderKeyRequired,
  PROVIDERS,
  parseModelString,
  ProviderConfigError,
  type ModelWithInfo,
} from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/types/provider';
import {
  getServerProviders,
  resolveApiKey,
  resolveBaseUrl,
  resolveProxy,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createLogger } from '@/lib/logger';

const log = createLogger('ResolveModel');

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
  /** Resolved provider ID (e.g. "openai", "ollama") */
  providerId: string;
  /** Effective API key after server-side fallback resolution */
  apiKey: string;
}

/**
 * Resolve a language model from explicit parameters.
 *
 * Use this when model config comes from the request body.
 */
export async function resolveModel(params: {
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
}): Promise<ResolvedModel> {
  const modelString = params.modelString || process.env.DEFAULT_MODEL || 'google:gemini-2.0-flash';
  const { providerId, modelId } = parseModelString(modelString);

  // SSRF validation applies only to client-supplied base URLs.
  // Server-configured URLs (e.g. OLLAMA_BASE_URL from env/YAML) flow through
  // resolveBaseUrl() and bypass this check — they're trusted by the operator.
  const clientBaseUrl = params.baseUrl || undefined;
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = await validateUrlForSSRF(clientBaseUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  let effectiveProviderId = providerId;
  let effectiveModelId = modelId;
  let effectiveModelString = modelString;

  const apiKey = clientBaseUrl
    ? params.apiKey || ''
    : resolveApiKey(effectiveProviderId, params.apiKey || '');

  // When no explicit model was requested (server-side default path) and the
  // default provider has no key, fall back to any server-configured provider.
  // This mirrors the frontend's isServerConfigured logic: use whatever is available.
  if (!params.modelString && isProviderKeyRequired(effectiveProviderId) && !apiKey) {
    const fallback = findConfiguredFallback(effectiveProviderId);
    if (fallback) {
      log.info(
        `Provider "${effectiveProviderId}" has no API key; falling back to "${fallback.providerId}:${fallback.modelId}"`,
      );
      effectiveProviderId = fallback.providerId;
      effectiveModelId = fallback.modelId;
      effectiveModelString = `${fallback.providerId}:${fallback.modelId}`;
    }
  }

  const effectiveApiKey = clientBaseUrl
    ? params.apiKey || ''
    : resolveApiKey(effectiveProviderId, params.apiKey || '');
  const baseUrl = clientBaseUrl
    ? clientBaseUrl
    : resolveBaseUrl(effectiveProviderId, params.baseUrl);
  const proxy = resolveProxy(effectiveProviderId);

  if (isProviderKeyRequired(effectiveProviderId) && !effectiveApiKey) {
    throw new ProviderConfigError(
      effectiveProviderId,
      `No API key configured for provider "${effectiveProviderId}". ` +
        `Set ${effectiveProviderId.toUpperCase()}_API_KEY in .env.local or server-providers.yml.`,
    );
  }

  const { model, modelInfo } = getModel({
    providerId: effectiveProviderId,
    modelId: effectiveModelId,
    apiKey: effectiveApiKey,
    baseUrl,
    proxy,
    providerType: params.providerType as 'openai' | 'anthropic' | 'google' | undefined,
  });

  return {
    model,
    modelInfo,
    modelString: effectiveModelString,
    providerId: effectiveProviderId,
    apiKey: effectiveApiKey,
  };
}

/**
 * Find a server-configured provider to fall back to when the requested
 * provider has no API key. Picks the first provider from the PROVIDERS
 * registry order that has a server-configured key, and returns its first
 * model. This mirrors the frontend's `isServerConfigured` semantics.
 */
function findConfiguredFallback(
  skipProviderId: string,
): { providerId: ProviderId; modelId: string } | null {
  const configured = getServerProviders();
  for (const pid of Object.keys(PROVIDERS) as ProviderId[]) {
    if (pid === skipProviderId) continue;
    if (!configured[pid]) continue;
    // Use server-restricted model list if available, else first model in registry
    const serverModels = configured[pid].models;
    const firstModelId = serverModels?.[0] ?? PROVIDERS[pid]?.models[0]?.id;
    if (firstModelId) {
      return { providerId: pid, modelId: firstModelId };
    }
  }
  return null;
}

/**
 * Resolve a language model from standard request headers.
 *
 * Reads: x-model, x-api-key, x-base-url, x-provider-type
 * Note: requiresApiKey is derived server-side from the provider registry,
 * never from client headers, to prevent auth bypass.
 */
export async function resolveModelFromHeaders(req: NextRequest): Promise<ResolvedModel> {
  return resolveModel({
    modelString: req.headers.get('x-model') || undefined,
    apiKey: req.headers.get('x-api-key') || undefined,
    baseUrl: req.headers.get('x-base-url') || undefined,
    providerType: req.headers.get('x-provider-type') || undefined,
  });
}
