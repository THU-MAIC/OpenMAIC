/**
 * How the settings name and picture a service: each capability's built-in
 * services (names, logos, whether they need a key), and the name and logo of
 * an entry or a provider. Shared by Model Services, the course model map and
 * the model pickers, so a provider looks the same everywhere. Data only (no
 * panels), so the home toolbar can use it.
 */
import { MONO_LOGO_PROVIDERS, PROVIDERS } from '@/lib/ai/providers';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { resolveASRProviderName, resolveTTSProviderName } from '@/lib/audio/provider-display';
import type { SlotCapability } from '@/lib/config/model-slots';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { entryConfigured, serviceEntries, type ServiceEntry } from '@/lib/model-settings/services';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS, getWebSearchProviderDisplayName } from '@/lib/web-search/constants';

import { IMAGE_PROVIDER_NAMES, VIDEO_PROVIDER_NAMES } from './media-provider-names';

type T = (key: string, options?: Record<string, unknown>) => string;

const IMAGE_PROVIDER_ICONS: Record<string, string> = {
  seedream: '/logos/doubao.svg',
  'openai-image': '/logos/openai.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
  'minimax-image': '/logos/minimax.svg',
  'grok-image': '/logos/grok.svg',
  'comfyui-image': '/logos/comfyui.svg',
  'openrouter-image': '/logos/openrouter.svg',
  lemonade: '/logos/lemonade.svg',
};

const VIDEO_PROVIDER_ICONS: Record<string, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  'minimax-video': '/logos/minimax.svg',
  'grok-video': '/logos/grok.svg',
  'openrouter-video': '/logos/openrouter.svg',
  happyhorse: '/logos/qwen.svg',
};

interface RegistryInfo {
  ids: readonly string[];
  name: (id: string, t: T) => string;
  icon: (id: string) => string | undefined;
  requiresApiKey: (id: string) => boolean;
}

type Entry = { name?: string; icon?: string; requiresApiKey?: boolean };
const entryOf = (registry: Record<string, Entry>, id: string): Entry | undefined => registry[id];
const translated = (t: T, key: string, fallback: string) => {
  const text = t(key);
  return text && text !== key ? text : fallback;
};

/** Each capability's built-in services: their names, logos and whether they need a key. */
export const REGISTRY_INFO: Record<SlotCapability, RegistryInfo> = {
  chat: {
    ids: Object.keys(PROVIDERS),
    name: (id, t) =>
      translated(t, `settings.providerNames.${id}`, entryOf(PROVIDERS, id)?.name ?? id),
    icon: (id) => entryOf(PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(PROVIDERS, id)?.requiresApiKey !== false,
  },
  image: {
    ids: Object.keys(IMAGE_PROVIDERS),
    name: (id, t) =>
      translated(
        t,
        `settings.${(IMAGE_PROVIDER_NAMES as Record<string, string>)[id]}`,
        entryOf(IMAGE_PROVIDERS, id)?.name ?? id,
      ),
    icon: (id) => IMAGE_PROVIDER_ICONS[id],
    requiresApiKey: (id) => entryOf(IMAGE_PROVIDERS, id)?.requiresApiKey !== false,
  },
  video: {
    ids: Object.keys(VIDEO_PROVIDERS),
    name: (id, t) =>
      translated(
        t,
        `settings.${(VIDEO_PROVIDER_NAMES as Record<string, string>)[id]}`,
        entryOf(VIDEO_PROVIDERS, id)?.name ?? id,
      ),
    icon: (id) => VIDEO_PROVIDER_ICONS[id],
    requiresApiKey: (id) => entryOf(VIDEO_PROVIDERS, id)?.requiresApiKey !== false,
  },
  tts: {
    ids: Object.keys(TTS_PROVIDERS),
    name: (id, t) => resolveTTSProviderName(id, t),
    icon: (id) => entryOf(TTS_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(TTS_PROVIDERS, id)?.requiresApiKey !== false,
  },
  asr: {
    ids: Object.keys(ASR_PROVIDERS),
    name: (id, t) => resolveASRProviderName(id, t),
    icon: (id) => entryOf(ASR_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(ASR_PROVIDERS, id)?.requiresApiKey !== false,
  },
  document: {
    ids: Object.keys(PDF_PROVIDERS),
    name: (id) => entryOf(PDF_PROVIDERS, id)?.name ?? id,
    icon: (id) => entryOf(PDF_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(PDF_PROVIDERS, id)?.requiresApiKey !== false,
  },
  webSearch: {
    ids: Object.keys(WEB_SEARCH_PROVIDERS),
    name: (id, t) => getWebSearchProviderDisplayName(id as never, t),
    icon: (id) => entryOf(WEB_SEARCH_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(WEB_SEARCH_PROVIDERS, id)?.requiresApiKey !== false,
  },
};

const PLAN_BY_PRESET = new Map(
  TOKEN_PLAN_PRESETS.map((plan) => [tokenPlanPresetId(plan.id), plan]),
);

/**
 * A service's name: a plan's own name; a built-in service's name for its
 * entry (a provider named after it included); else the provider's preset and
 * id ("OpenAI-compatible · gateway"), so two accounts of one service stay apart.
 */
export function entryName(entry: ServiceEntry, capability: SlotCapability, t: T): string {
  const provider = entry.provider;
  const plan = provider ? PLAN_BY_PRESET.get(provider.preset) : undefined;
  if (plan) return plan.id === 'volcengine-ark' ? 'Seed' : plan.name;
  if (!provider || entry.serviceId) {
    return REGISTRY_INFO[capability].name(entry.serviceId ?? entry.registryId, t);
  }
  const presetName =
    provider.preset === 'openai-compatible'
      ? t('settings.serverConfig.openaiCompatible')
      : REGISTRY_INFO[capability].name(entry.registryId, t);
  return `${presetName} · ${provider.id}`;
}

/** A service's logo: its plan's or built-in service's; none (a generic box) for a custom endpoint. */
export function entryIcon(entry: ServiceEntry, capability: SlotCapability): string | undefined {
  const plan = entry.provider ? PLAN_BY_PRESET.get(entry.provider.preset) : undefined;
  if (plan) return plan.icon;
  if (entry.serviceId) return REGISTRY_INFO[capability].icon(entry.serviceId);
  if (entry.provider?.preset === 'openai-compatible') return undefined;
  return REGISTRY_INFO[capability].icon(entry.registryId);
}

export function isEntryConfigured(entry: ServiceEntry, capability: SlotCapability): boolean {
  return entryConfigured(entry, REGISTRY_INFO[capability].requiresApiKey(entry.registryId));
}

/**
 * A provider's logo for a capability, as its Model Services entry shows it:
 * its plan's, its built-in service's (a provider named after one included),
 * else its preset's; none (a generic icon) for a custom endpoint.
 */
export function providerLogo(
  view: ModelSettingsView,
  providerId: string,
  capability: SlotCapability,
): string | undefined {
  const entry = serviceEntries(view, capability, REGISTRY_INFO[capability].ids).find(
    (item) => item.id === providerId,
  );
  return entry ? entryIcon(entry, capability) : undefined;
}

/** Whether a logo is a single-colour mark that needs inverting on a dark background. */
export function logoInverts(
  view: ModelSettingsView,
  providerId: string,
  capability: SlotCapability,
) {
  const entry = serviceEntries(view, capability, REGISTRY_INFO[capability].ids).find(
    (item) => item.id === providerId,
  );
  return !!entry && MONO_LOGO_PROVIDERS.has(entry.serviceId ?? entry.registryId);
}
