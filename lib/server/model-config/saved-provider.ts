/**
 * Testing a saved provider from the settings (RFC #1701): the browser names a
 * provider the workspace can use (the deployment's or its own) and, where it
 * matters, a model; the server tests it with the stored configuration. No key
 * or endpoint comes from the browser.
 */
import { getProvider } from '@/lib/ai/providers';
import { getSlot } from '@/lib/config/model-slots';
import { apiError } from '@/lib/server/api-response';
import { InvalidOwnerCredentialError } from '@/lib/server/identity/resolve';
import { invalidOwnerCredentialResponse } from '@/lib/server/identity/with-owner';
import type { OwnerAuthRequest } from '@/lib/server/identity/types';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { ProviderId } from '@/lib/types/provider';

import { languageModelFor } from './llm';
import {
  mediaConnectionFor,
  mediaResolutionResponse,
  type MediaConnection,
  type MediaSlot,
} from './media';
import { SlotResolutionError } from './resolve-slot';
import { requestWorkspaceId, savedProviderTarget } from './runtime';

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The saved provider a request names (`provider`, with an optional `model`),
 * as a model reference; undefined when it names none (the request then uses
 * the older fields). Throws SavedProviderError for a malformed id.
 */
export function savedProviderRef(provider: unknown, model?: unknown): string | undefined {
  if (provider === undefined || provider === null || provider === '') return undefined;
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) {
    throw new SavedProviderError('Invalid provider id');
  }
  const modelId = typeof model === 'string' ? model.trim() : '';
  return modelId ? `${provider}:${modelId}` : provider;
}

export class SavedProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedProviderError';
  }
}

/** A language model for a saved chat provider, as the calls would build it. */
export async function savedLanguageModel(
  req: OwnerAuthRequest,
  ref: string,
): Promise<ResolvedModel> {
  const target = await savedProviderTarget(ref, 'chat', await requestWorkspaceId(req));
  return languageModelFor(target);
}

/** The connection for a saved media, search or document provider. */
export async function savedMediaConnection(
  req: OwnerAuthRequest,
  slot: MediaSlot,
  ref: string,
): Promise<MediaConnection> {
  const target = await savedProviderTarget(
    ref,
    getSlot(slot).capability,
    await requestWorkspaceId(req),
  );
  return mediaConnectionFor(slot, target);
}

/** The response for a saved provider that cannot be tested, or undefined for any other error. */
export function savedProviderResponse(error: unknown, what: string): Response | undefined {
  if (error instanceof SavedProviderError) return apiError('INVALID_REQUEST', 400, error.message);
  // The message names a path, never a value from the request.
  if (error instanceof SlotResolutionError) {
    return apiError('MISSING_PROVIDER', 400, `No such ${what} provider is configured`);
  }
  if (error instanceof InvalidOwnerCredentialError) return invalidOwnerCredentialResponse();
  return mediaResolutionResponse(error, what);
}

/**
 * The endpoint and key of one of the workspace's own chat providers, for
 * listing the models it serves (a deployment's providers are not the
 * workspace's to edit).
 */
export async function savedChatEndpoint(
  req: OwnerAuthRequest,
  providerId: string,
): Promise<{ baseUrl?: string; apiKey: string }> {
  const target = await savedProviderTarget(providerId, 'chat', await requestWorkspaceId(req), {
    workspaceOnly: true,
  });
  const registered = getProvider(target.registryId as ProviderId);
  return {
    baseUrl: target.baseUrl ?? registered?.defaultBaseUrl,
    apiKey: target.apiKey ?? '',
  };
}
