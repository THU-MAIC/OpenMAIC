import type { ModelSettingsView } from '@/lib/model-settings/client';

export interface CameraTutorCapabilities {
  /** Resolved classroom provider preset (e.g. 'google', 'openai', 'anthropic', 'deepseek'). */
  providerPreset: string | null;
  /** Resolved classroom provider display name or id. */
  providerName: string | null;
  /** Resolved classroom model id (e.g. 'gemini-4-hydrogen', 'gpt-4o'). */
  modelId: string | null;
  /** True when the configured classroom provider supports real-time Gemini Live streaming. */
  supportsLiveStreaming: boolean;
  /** False for known text-only chat models that reject image inputs. */
  supportsVision: boolean;
}

const TEXT_ONLY_MODEL_PATTERNS: RegExp[] = [
  /^deepseek-(chat|reasoner|coder|r1|v2|v3)/i,
  /^o1-mini/i,
  /^o3-mini/i,
  /^qwen-(turbo|plus|max|long)(?!.*vl)/i,
  /^qwen2\.5-(?!.*vl)/i,
  /^llama-?3(\.\d)?-(8b|70b|405b)(?!.*vision)/i,
  /^mistral-(tiny|small|medium|large)(?!.*pixtral|.*vision)/i,
  /^glm-4-(flash|air|plus|long)(?!.*v)/i,
];

function isOfficialGoogleBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

export function isLikelyTextOnlyModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.trim();
  return TEXT_ONLY_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function modelSupportsVision(
  modelId: string | null | undefined,
  cataloguedVision?: boolean,
): boolean {
  if (typeof cataloguedVision === 'boolean') return cataloguedVision;
  return !isLikelyTextOnlyModel(modelId);
}

export function getCameraTutorCapabilities(
  view: ModelSettingsView | null | undefined,
): CameraTutorCapabilities {
  if (!view) {
    return {
      providerPreset: null,
      providerName: null,
      modelId: null,
      supportsLiveStreaming: false,
      supportsVision: true,
    };
  }

  const slot =
    view.slots.find((s) => s.slot === 'classroom') ?? view.slots.find((s) => s.slot === 'llm');
  const eff = slot?.effective;
  if (!eff || eff.status !== 'assigned') {
    return {
      providerPreset: null,
      providerName: null,
      modelId: null,
      supportsLiveStreaming: false,
      supportsVision: true,
    };
  }

  const provider = view.providers.find((p) => p.id === eff.providerId);
  const preset = provider?.preset ?? eff.providerId;
  const providerName = provider?.presetName ?? eff.providerId;
  const modelId = eff.modelId ?? null;
  const supportsLiveStreaming =
    preset === 'google' &&
    provider?.hasCustomBaseUrl !== true &&
    provider?.liveStreamingAuthorized !== false &&
    isOfficialGoogleBaseUrl(provider?.baseUrl);

  const cataloguedModel = modelId
    ? provider?.capabilities?.chat?.models?.find((m) => m.id === modelId)
    : undefined;
  const supportsVision = modelSupportsVision(modelId, cataloguedModel?.capabilities?.vision);

  return {
    providerPreset: preset,
    providerName,
    modelId,
    supportsLiveStreaming,
    supportsVision,
  };
}
