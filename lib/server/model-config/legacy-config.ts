/**
 * Legacy model configuration → the model configuration of RFC #1701 (#1725).
 *
 * Only the unambiguous part carries over: providers (environment variables and
 * `server-providers.yml`), `DEFAULT_MODEL` as the llm root and `MODEL_FALLBACK`
 * as its fallback. Per-stage `MODEL_ROUTES` do not map one to one onto slots
 * (several stages share a slot, the agent driver and retries follow rules of
 * their own), so a deployment that sets them has to write `openmaic.yml`; see
 * `loadDeploymentLayer`.
 *
 * The translation is lenient: an entry that cannot carry over becomes a notice
 * and is left out, never a startup failure. Notices never repeat configured
 * values, only registry ids and configuration names.
 */
import { PROVIDERS, parseModelString } from '@/lib/ai/providers';
import type { SlotCapability, SlotId } from '@/lib/config/model-slots';
import { PRESET_ID_OVERRIDES, getProviderPreset } from '@/lib/config/provider-presets';
import {
  providerSchema,
  type ModelConfigFile,
  type SlotAssignment,
} from '@/lib/server/model-config/openmaic-yml';
import type { ServerConfig, ServerProviderEntry } from '@/lib/server/provider-config';

export interface LegacyModelSettings {
  /** `DEFAULT_MODEL`. */
  defaultModel?: string;
  /** `MODEL_FALLBACK`: the retry model. */
  globalFallback?: string;
  /** `DEFAULT_IMAGE_PROVIDER`: the image provider to prefer. */
  defaultImageProvider?: string;
}

export interface LegacyTranslation {
  config: ModelConfigFile;
  /** What did not carry over, for a startup warning. */
  notices: string[];
}

type Section = Exclude<keyof ServerConfig, 'disabled'>;

const SECTION_CAPABILITY: Record<Section, SlotCapability> = {
  providers: 'chat',
  tts: 'tts',
  asr: 'asr',
  pdf: 'document',
  image: 'image',
  video: 'video',
  webSearch: 'webSearch',
};

const DISABLE_SECTION: Partial<Record<Section, keyof ServerConfig['disabled']>> = {
  tts: 'tts',
  asr: 'asr',
  image: 'image',
  video: 'video',
  webSearch: 'webSearch',
};

/** The preset (and so provider) id for a registry entry of a capability. */
export function legacyProviderId(capability: SlotCapability, registryId: string): string {
  return PRESET_ID_OVERRIDES[capability]?.[registryId] ?? registryId;
}

function translateProvider(entry: ServerProviderEntry, presetId: string) {
  const credentials: Record<string, string> = {};
  if (entry.accessKeyId) credentials.accessKeyId = entry.accessKeyId;
  if (entry.accessKeySecret) credentials.accessKeySecret = entry.accessKeySecret;
  return {
    preset: presetId,
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.models?.length ? { models: [...entry.models] } : {}),
    ...(entry.proxy ? { proxy: entry.proxy } : {}),
    ...(Object.keys(credentials).length ? { credentials } : {}),
  };
}

/** Field names a schema rejected, never their values. */
function rejectedFields(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string {
  const fields = new Set(
    error.issues.map((issue) => issue.path.map(String).join('.') || '(entry)'),
  );
  return [...fields].join(', ');
}

/** Section → the media slot its server default provider fills. */
const MEDIA_DEFAULTS: ReadonlyArray<[Section, SlotId]> = [
  ['tts', 'tts'],
  ['asr', 'asr'],
  ['image', 'image'],
  ['video', 'video'],
  ['webSearch', 'webSearch'],
  ['pdf', 'document'],
];

/** The order the server preferred web search providers in (with a key). */
const WEB_SEARCH_PRIORITY = ['tavily', 'exa', 'bocha', 'baidu', 'minimax', 'claude'];

/** `providerId` or `providerId:modelId`, as openmaic.yml accepts it. */
const MODEL_REF_SHAPE_ANY = /^[a-z0-9][a-z0-9-]{0,62}(?::.+)?$/;

/** What `providerId:modelId` looks like in openmaic.yml (no line breaks in the model id). */
const MODEL_REF_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}:.+$/;

/** A registry id with a preset for this capability, safe to name in a notice. */
function isKnown(capability: SlotCapability, registryId: string): boolean {
  const preset = getProviderPreset(legacyProviderId(capability, registryId));
  return preset?.capabilities[capability]?.registryId === registryId;
}

export function translateLegacyConfig(
  server: Readonly<ServerConfig>,
  settings: LegacyModelSettings = {},
): LegacyTranslation {
  const notices: string[] = [];
  const providers: NonNullable<ModelConfigFile['providers']> = {};
  /** Provider ids translated from the providers (chat) section. */
  const chatProviders = new Set<string>();

  for (const section of Object.keys(SECTION_CAPABILITY) as Section[]) {
    const capability = SECTION_CAPABILITY[section];
    const disabled = DISABLE_SECTION[section] ? server.disabled[DISABLE_SECTION[section]!] : null;
    for (const [registryId, entry] of Object.entries(server[section])) {
      if (disabled?.has(registryId)) continue;
      const id = legacyProviderId(capability, registryId);
      const preset = getProviderPreset(id);
      if (!preset || !isKnown(capability, registryId)) {
        // Not a registry id, so possibly anything: the key is not repeated.
        notices.push(`An entry in ${section} has no matching preset and is not carried over`);
        continue;
      }
      const provider = translateProvider(entry, id);
      const checked = providerSchema.safeParse(provider);
      if (!checked.success) {
        notices.push(
          `${section}.${registryId} is not carried over: invalid ${rejectedFields(checked.error)}`,
        );
        continue;
      }
      if (preset.requiresBaseUrl && !provider.baseUrl) {
        notices.push(`${section}.${registryId} is not carried over: it needs a base URL`);
        continue;
      }
      providers[id] = checked.data;
      if (capability === 'chat') chatProviders.add(id);
    }
    // A force-off switch hides a provider from users; the new configuration
    // expresses that by leaving it out, which is only true of configured ones.
    for (const registryId of disabled ?? []) {
      if (!isKnown(capability, registryId)) continue;
      notices.push(
        `${section}.${registryId} is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null`,
      );
    }
  }

  /**
   * A chat model string as a reference to a declared provider, or undefined.
   * Only a registry id is named in the notice: anything else may be a
   * credential pasted into the wrong variable.
   */
  const chatRef = (modelString: string, what: string): string | undefined => {
    const { providerId, modelId } = parseModelString(modelString);
    const named = Object.hasOwn(PROVIDERS, providerId) ? `provider "${providerId}"` : 'a provider';
    const id = legacyProviderId('chat', providerId);
    // A chat provider from the providers section; other sections' ids never
    // served a chat stage.
    if (!Object.hasOwn(server.providers, providerId) || !chatProviders.has(id)) {
      notices.push(`${what} uses ${named} without server configuration; it is left to the browser`);
      return undefined;
    }
    const ref = `${id}:${modelId}`;
    if (!MODEL_REF_SHAPE.test(ref)) {
      notices.push(`${what} is not a valid model reference and is not carried over`);
      return undefined;
    }
    return ref;
  };

  const slots: NonNullable<ModelConfigFile['slots']> = {};
  const defaultRef = settings.defaultModel
    ? chatRef(settings.defaultModel, 'DEFAULT_MODEL')
    : undefined;
  const fallback = settings.globalFallback
    ? chatRef(settings.globalFallback, 'MODEL_FALLBACK')
    : undefined;
  if (defaultRef) {
    slots.llm = (fallback ? { model: defaultRef, fallback } : defaultRef) satisfies SlotAssignment;
    // The agent never used DEFAULT_MODEL: it needs its own maic-agent-driver
    // route, which only MODEL_ROUTES could give. Without one it is off, and
    // null keeps it off rather than inheriting the llm root.
    slots.agent = null;
  } else if (fallback) {
    // A fallback belongs to an assignment, and without DEFAULT_MODEL there is
    // none to hold it: calls that retried on MODEL_FALLBACK stop retrying.
    notices.push(
      'MODEL_FALLBACK is not carried over without DEFAULT_MODEL, so calls that retried on it no longer do; set the llm slot with a fallback in openmaic.yml',
    );
  }

  // Media and tool capabilities: the provider the server picked when a
  // request named none (the first configured one; web search by its old
  // priority), with the first pinned model, else the provider's default.
  for (const [section, slot] of MEDIA_DEFAULTS) {
    const capability = SECTION_CAPABILITY[section];
    const usable = Object.entries(server[section]).filter(([registryId]) =>
      Object.hasOwn(providers, legacyProviderId(capability, registryId)),
    );
    const preferred =
      section === 'webSearch'
        ? WEB_SEARCH_PRIORITY.map((id) => usable.find(([registryId]) => registryId === id)).find(
            (entry) => entry?.[1].apiKey,
          )
        : section === 'image' && settings.defaultImageProvider
          ? usable.find(([registryId]) => registryId === settings.defaultImageProvider)
          : undefined;
    // An explicit image default that is not configured stays unassigned (the
    // agent's image tool failed on it before): never another vendor instead.
    if (section === 'image' && settings.defaultImageProvider && !preferred) {
      notices.push(
        `DEFAULT_IMAGE_PROVIDER "${settings.defaultImageProvider}" has no usable configuration, so no image model is assigned; set the image slot in openmaic.yml`,
      );
      continue;
    }
    const picked = preferred ?? usable[0];
    if (!picked) continue;
    const [registryId, entry] = picked;
    const model = entry.models?.find(Boolean);
    const ref = legacyProviderId(capability, registryId) + (model ? `:${model}` : '');
    if (MODEL_REF_SHAPE_ANY.test(ref)) slots[slot] = ref;
  }

  const config: ModelConfigFile = {};
  if (Object.keys(providers).length) config.providers = providers;
  if (Object.keys(slots).length) config.slots = slots;
  return { config, notices };
}
