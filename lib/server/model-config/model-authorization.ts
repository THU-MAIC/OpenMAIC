import { getSlot, isSlotId, type SlotCapability } from '@/lib/config/model-slots';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { getProvider } from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/types/provider';
import { TTS_PROVIDERS, ASR_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { CLAUDE_WEB_SEARCH_DEFAULT_MODEL } from '@/lib/web-search/constants';
import type { ModelConfigFile } from './openmaic-yml';

function usesServerAccount(registryId?: string): boolean {
  return !!registryId && getProvider(registryId as ProviderId)?.serverAdapter === true;
}

/** Whether this provider uses a key, an SDK credential chain, or a server's signed-in account. */
export function usesServerCredentials(provider: {
  preset?: string;
  apiKey?: string;
  credentials?: Record<string, string>;
}): boolean {
  return Boolean(
    provider.apiKey ||
    Object.values(provider.credentials ?? {}).some(Boolean) ||
    provider.preset === 'bedrock' ||
    (provider.preset &&
      usesServerAccount(getProviderPreset(provider.preset)?.capabilities.chat?.registryId)),
  );
}

/** Whether the capability sends a selected model to the provider. */
export function selectsUpstreamModel(presetId: string, capability: SlotCapability): boolean {
  const target = getProviderPreset(presetId)?.capabilities[capability];
  return Boolean(target && (capability === 'chat' || deploymentDefaultModel(presetId, capability)));
}

/** Fixed text: a refusal must not expose the operator's model catalogue or key. */
export class ModelAuthorizationError extends Error {
  readonly code = 'PROVIDER_DISABLED';
  readonly httpStatus = 403;

  constructor() {
    super('This model is not authorized for server-managed credentials');
    this.name = 'ModelAuthorizationError';
  }
}

/** The single adapter default a deployment's provider-only slot references. */
export function deploymentDefaultModel(
  presetId: string,
  capability: SlotCapability,
): string | undefined {
  const target = getProviderPreset(presetId)?.capabilities[capability];
  if (!target) return undefined;
  if (target.defaultModel) return target.defaultModel;
  const id = target.registryId;
  if (capability === 'tts')
    return TTS_PROVIDERS[id as keyof typeof TTS_PROVIDERS]?.defaultModelId || undefined;
  if (capability === 'asr')
    return ASR_PROVIDERS[id as keyof typeof ASR_PROVIDERS]?.defaultModelId || undefined;
  if (capability === 'image')
    return IMAGE_PROVIDERS[id as keyof typeof IMAGE_PROVIDERS]?.models?.[0]?.id;
  if (capability === 'video')
    return VIDEO_PROVIDERS[id as keyof typeof VIDEO_PROVIDERS]?.models?.[0]?.id;
  if (capability === 'webSearch')
    return id === 'claude' ? CLAUDE_WEB_SEARCH_DEFAULT_MODEL : undefined;
  return undefined;
}

const legacyReferences = new WeakMap<ModelConfigFile, string[]>();

/** Preserve a legacy fallback even when there is no default assignment to hold it. */
export function authorizeLegacyReferences(config: ModelConfigFile, references: string[]): void {
  legacyReferences.set(config, references);
}

/** Shared source for authorization and the deployment provider's model picker. */
export function deploymentAuthorizedModels(
  config: ModelConfigFile | undefined,
  providerId: string,
  capability: SlotCapability = 'chat',
): string[] {
  const providers = config?.providers;
  if (!providers || !Object.hasOwn(providers, providerId)) return [];
  const provider = providers[providerId];
  const models = new Set(provider.models ?? []);
  const prefix = `${providerId}:`;
  const addReference = (reference: string | undefined) => {
    if (reference?.startsWith(prefix)) models.add(reference.slice(prefix.length));
    else if (reference === providerId) {
      const model = deploymentDefaultModel(provider.preset, capability);
      if (model) models.add(model);
    }
  };

  for (const [slot, assignment] of Object.entries(config?.slots ?? {})) {
    if (!isSlotId(slot) || getSlot(slot).capability !== capability) continue;
    if (typeof assignment === 'string') {
      addReference(assignment);
    } else if (assignment) {
      addReference(assignment.model);
      addReference(assignment.fallback);
    }
  }
  if (capability === 'chat')
    for (const ref of legacyReferences.get(config!) ?? []) addReference(ref);
  return [...models];
}

/** A model limit for the credentials this provider uses, or undefined for its own account. */
export function providerModelAllowlist(
  config: ModelConfigFile | undefined,
  providerId: string,
  registryId: string,
  capability: SlotCapability,
): string[] | undefined {
  const providers = config?.providers;
  if (!providers) return undefined;
  const declared = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
  const registryFor = (preset: string) =>
    getProviderPreset(preset)?.capabilities[capability]?.registryId;
  if (declared && registryFor(declared.preset) === registryId && usesServerCredentials(declared)) {
    return deploymentAuthorizedModels(config, providerId, capability);
  }
  // Every alias of a server adapter uses the same account. A workspace or a
  // legacy registry id can use only models the operator granted for that account.
  if (capability !== 'chat' || !usesServerAccount(registryId)) return undefined;
  const aliases = Object.entries(providers).filter(
    ([, provider]) => registryFor(provider.preset) === registryId,
  );
  return aliases.length
    ? [...new Set(aliases.flatMap(([id]) => deploymentAuthorizedModels(config, id, capability)))]
    : undefined;
}

/** Only operator declarations grant access; workspace assignments and SDK catalogues do not. */
export function assertDeploymentModelAuthorized(
  config: ModelConfigFile | undefined,
  providerId: string,
  modelId: string,
  capability: SlotCapability = 'chat',
): void {
  if (!deploymentAuthorizedModels(config, providerId, capability).includes(modelId)) {
    throw new ModelAuthorizationError();
  }
}
