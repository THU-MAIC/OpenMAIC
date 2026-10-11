/**
 * Server-side Provider Configuration
 *
 * Loads provider configs from YAML (primary) + environment variables (fallback).
 * Keys never leave the server — only provider IDs and metadata are exposed via API.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL,
  isQwenCatalogVoice,
  isQwenVoiceCloneModel,
  TTS_PROVIDERS,
  ASR_PROVIDERS,
} from '@/lib/audio/constants';

import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { CLAUDE_WEB_SEARCH_DEFAULT_MODEL } from '@/lib/web-search/constants';
import { LLM_STAGES, getStageRoute } from '@/lib/server/model-routes';
import { ModelAuthorizationError } from '@/lib/server/model-authorization';

const log = createLogger('ServerProviderConfig');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerProviderEntry {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  proxy?: string;
  /** Aliyun AccessKey ID (AliDocMind — uses AK/SK instead of a single apiKey). */
  accessKeyId?: string;
  /** Aliyun AccessKey Secret (AliDocMind). */
  accessKeySecret?: string;
  /**
   * Admin/operator force-off switch. `false` disables the provider for ALL
   * clients regardless of the user's per-provider toggle (server precedence).
   * Honored for the capability sections in {@link DISABLE_ENV_MAPS} (#665).
   */
  enabled?: boolean;
}

interface ServerConfig {
  providers: Record<string, ServerProviderEntry>;
  tts: Record<string, ServerProviderEntry>;
  asr: Record<string, ServerProviderEntry>;
  pdf: Record<string, ServerProviderEntry>;
  image: Record<string, ServerProviderEntry>;
  video: Record<string, ServerProviderEntry>;
  webSearch: Record<string, ServerProviderEntry>;
  /** Provider IDs the operator force-disabled per capability section (server precedence). */
  disabled: Record<CapabilitySection, Set<string>>;
}

// ---------------------------------------------------------------------------
// Env-var prefix mappings
// ---------------------------------------------------------------------------

/**
 * Env-var prefix → LLM provider-id mapping (e.g. `DEEPSEEK_API_KEY` configures
 * the `deepseek` provider). Exported for boot-time config validation, which
 * checks `<PREFIX>_MODELS` pins against the provider's key env.
 */
export const LLM_ENV_MAP: Record<string, string> = {
  OPENAI: 'openai',
  AZURE_OPENAI: 'azure',
  ATLASCLOUD: 'atlascloud',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  DEEPSEEK: 'deepseek',
  QWEN: 'qwen',
  KIMI: 'kimi',
  MINIMAX: 'minimax',
  GLM: 'glm',
  SILICONFLOW: 'siliconflow',
  DOUBAO: 'doubao',
  OPENROUTER: 'openrouter',
  GROK: 'grok',
  TENCENT: 'tencent-hunyuan',
  TENCENT_HUNYUAN: 'tencent-hunyuan',
  XIAOMI: 'xiaomi',
  MIMO: 'xiaomi',
  TOKENDANCE: 'tokendance',
  OLLAMA: 'ollama',
  LEMONADE: 'lemonade',
  BEDROCK: 'bedrock',
};

const TTS_ENV_MAP: Record<string, string> = {
  TTS_OPENAI: 'openai-tts',
  TTS_AZURE: 'azure-tts',
  TTS_GLM: 'glm-tts',
  TTS_QWEN: 'qwen-tts',
  TTS_VOXCPM: 'voxcpm-tts',
  TTS_DOUBAO: 'doubao-tts',
  TTS_ELEVENLABS: 'elevenlabs-tts',
  TTS_MINIMAX: 'minimax-tts',
  TTS_LEMONADE: 'lemonade-tts',
};

const ASR_ENV_MAP: Record<string, string> = {
  ASR_OPENAI: 'openai-whisper',
  ASR_QWEN: 'qwen-asr',
  ASR_AZURE: 'azure-asr',
  ASR_FUNASR: 'funasr-asr',
  ASR_LEMONADE: 'lemonade-asr',
};

const PDF_ENV_MAP: Record<string, string> = {
  PDF_UNPDF: 'unpdf',
  PDF_MINERU: 'mineru',
  PDF_MINERU_CLOUD: 'mineru-cloud',
};

const IMAGE_ENV_MAP: Record<string, string> = {
  IMAGE_OPENAI: 'openai-image',
  IMAGE_SEEDREAM: 'seedream',
  IMAGE_QWEN_IMAGE: 'qwen-image',
  IMAGE_NANO_BANANA: 'nano-banana',
  IMAGE_MINIMAX: 'minimax-image',
  IMAGE_GROK: 'grok-image',
  IMAGE_LEMONADE: 'lemonade',
  IMAGE_OPENROUTER: 'openrouter-image',
};

const VIDEO_ENV_MAP: Record<string, string> = {
  VIDEO_SEEDANCE: 'seedance',
  VIDEO_KLING: 'kling',
  VIDEO_VEO: 'veo',
  VIDEO_MINIMAX: 'minimax-video',
  VIDEO_GROK: 'grok-video',
  VIDEO_HAPPYHORSE: 'happyhorse',
  VIDEO_OPENROUTER: 'openrouter-video',
};

const WEB_SEARCH_ENV_MAP: Record<string, string> = {
  TAVILY: 'tavily',
  EXA: 'exa',
  BOCHA: 'bocha',
  BRAVE: 'brave',
  BAIDU: 'baidu',
  // WEB_SEARCH_ prefix avoids colliding with ANTHROPIC_* LLM provider vars.
  WEB_SEARCH_CLAUDE: 'claude',
  WEB_SEARCH_MINIMAX: 'minimax',
  // Dedicated prefix avoids colliding with the Doubao LLM provider vars.
  WEB_SEARCH_DOUBAO: 'doubao',
  SEARXNG: 'searxng',
};

// ---------------------------------------------------------------------------
// Force-disable maps
// ---------------------------------------------------------------------------

/**
 * Capability sections that support the operator force-off switch
 * (`<CAP>_<PREFIX>_ENABLED=false`). LLM and PDF are intentionally not included:
 * their enablement stays purely credential-driven.
 */
type CapabilitySection = 'tts' | 'asr' | 'image' | 'video' | 'webSearch';

/**
 * Env prefixes for each capability's force-disable switch
 * (`<CAP>_<PREFIX>_ENABLED=false`). Built from the existing per-section env
 * maps plus the client-only keyless providers that have no credential env
 * (browser-native, ComfyUI) — operators may still want to force those off
 * fleet-wide (#665). The `_ENABLED` vars can only disable; they never
 * force-enable a provider that has no credentials configured.
 */
const DISABLE_ENV_MAPS: Record<CapabilitySection, Record<string, string>> = {
  tts: {
    ...TTS_ENV_MAP,
    TTS_BROWSER_NATIVE: 'browser-native-tts',
  },
  asr: {
    ...ASR_ENV_MAP,
    ASR_BROWSER_NATIVE: 'browser-native',
  },
  image: {
    ...IMAGE_ENV_MAP,
    // comfyui-image lives in the client-side catalog only (no credential env),
    // but operators may still want to force it off fleet-wide.
    IMAGE_COMFYUI: 'comfyui-image',
  },
  video: { ...VIDEO_ENV_MAP },
  webSearch: { ...WEB_SEARCH_ENV_MAP },
};

/** YAML section key per capability (web-search is hyphenated in YAML). */
const YAML_SECTION_KEY: Record<CapabilitySection, keyof YamlData> = {
  tts: 'tts',
  asr: 'asr',
  image: 'image',
  video: 'video',
  webSearch: 'web-search',
};

// ---------------------------------------------------------------------------
// YAML loading
// ---------------------------------------------------------------------------

type YamlData = Partial<{
  providers: Record<string, Partial<ServerProviderEntry>>;
  tts: Record<string, Partial<ServerProviderEntry>>;
  asr: Record<string, Partial<ServerProviderEntry>>;
  pdf: Record<string, Partial<ServerProviderEntry>>;
  image: Record<string, Partial<ServerProviderEntry>>;
  video: Record<string, Partial<ServerProviderEntry>>;
  'web-search': Record<string, Partial<ServerProviderEntry>>;
}>;

function loadYamlFile(filename: string): YamlData {
  try {
    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as YamlData;
  } catch (e) {
    log.warn(`[ServerProviderConfig] Failed to load ${filename}:`, e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Env-var helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a configured model list the same way the env-var path does:
 * trim whitespace and drop empty entries. The YAML path stores model arrays
 * verbatim, so without this a garbage `models: [""]` would surface as a
 * truthy pin (its first entry, an empty string). Returns undefined when
 * nothing survives normalization ("no models configured").
 */
function normalizeModelList(models: string[] | undefined): string[] | undefined {
  const parsed = models?.map((model) => model.trim()).filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function loadEnvSection(
  envMap: Record<string, string>,
  yamlSection: Record<string, Partial<ServerProviderEntry>> | undefined,
  {
    requiresBaseUrl = false,
    keylessProviders = new Set<string>(),
    baseUrlOptionalProviders = new Set<string>(),
  }: {
    requiresBaseUrl?: boolean;
    keylessProviders?: Set<string>;
    baseUrlOptionalProviders?: Set<string>;
  } = {},
): Record<string, ServerProviderEntry> {
  const result: Record<string, ServerProviderEntry> = {};
  const requiresBaseUrlForProvider = (providerId: string) =>
    requiresBaseUrl && !baseUrlOptionalProviders.has(providerId);

  // First, add everything from YAML as defaults
  if (yamlSection) {
    for (const [id, entry] of Object.entries(yamlSection)) {
      if (
        requiresBaseUrlForProvider(id)
          ? !!entry?.baseUrl
          : entry?.apiKey || (entry?.baseUrl && keylessProviders.has(id))
      ) {
        result[id] = {
          apiKey: entry.apiKey || '',
          baseUrl: entry.baseUrl,
          models: normalizeModelList(entry.models),
          proxy: entry.proxy,
        };
      }
    }
  }

  // Then, apply env vars (env takes priority over YAML)
  for (const [prefix, providerId] of Object.entries(envMap)) {
    const envApiKey = process.env[`${prefix}_API_KEY`] || undefined;
    const envBaseUrl = process.env[`${prefix}_BASE_URL`] || undefined;
    const envModelsStr = process.env[`${prefix}_MODELS`];
    const envModels = envModelsStr
      ? envModelsStr
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean)
      : undefined;

    if (result[providerId]) {
      // YAML entry exists — env vars override individual fields
      if (envApiKey) result[providerId].apiKey = envApiKey;
      if (envBaseUrl) result[providerId].baseUrl = envBaseUrl;
      if (envModels) result[providerId].models = envModels;
      continue;
    }

    // Activate on API key, or base URL alone for keyless providers (e.g. Ollama)
    if (
      requiresBaseUrlForProvider(providerId)
        ? !envBaseUrl
        : !(envApiKey || (envBaseUrl && keylessProviders.has(providerId)))
    )
      continue;
    result[providerId] = {
      apiKey: envApiKey || '',
      baseUrl: envBaseUrl,
      models: envModels,
    };
  }

  return result;
}

/** Parse a boolean-ish env value. Falsey words ⇒ false; anything else ⇒ true. */
function parseBooleanEnv(raw: string): boolean {
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

/**
 * Collect provider IDs the operator force-disabled per capability section, from
 * YAML (`<section>.<id>.enabled: false`) and env (`<CAP>_<PREFIX>_ENABLED`).
 * An explicit env `true` overrides a YAML disable (env precedence, matching the
 * rest of this module). Unset / empty values are "no opinion" — they never
 * silently override an explicit YAML disable. The `_ENABLED` vars can only
 * disable; they never create or force-enable a provider entry.
 */
function collectDisabledProviders(yamlData: YamlData): Record<CapabilitySection, Set<string>> {
  const disabled: Record<CapabilitySection, Set<string>> = {
    tts: new Set<string>(),
    asr: new Set<string>(),
    image: new Set<string>(),
    video: new Set<string>(),
    webSearch: new Set<string>(),
  };
  for (const section of Object.keys(DISABLE_ENV_MAPS) as CapabilitySection[]) {
    const yamlSection = yamlData[YAML_SECTION_KEY[section]];
    if (yamlSection) {
      for (const [id, entry] of Object.entries(yamlSection)) {
        if (entry?.enabled === false) disabled[section].add(id);
      }
    }
    for (const [prefix, providerId] of Object.entries(DISABLE_ENV_MAPS[section])) {
      const raw = process.env[`${prefix}_ENABLED`];
      // Treat unset / empty (e.g. a blank CI-templated value) as "no opinion" so
      // it never silently overrides an explicit YAML disable.
      if (raw === undefined || raw.trim() === '') continue;
      if (parseBooleanEnv(raw)) disabled[section].delete(providerId);
      else disabled[section].add(providerId);
    }
  }
  return disabled;
}

// ---------------------------------------------------------------------------
// Module-level cache (process singleton)
// ---------------------------------------------------------------------------

const DEFAULT_FILENAME = 'server-providers.yml';
const OPENAI_IMAGE_PROVIDER_ID = 'openai-image';
const ALIDOCMIND_PROVIDER_ID = 'alidocmind';
const BEDROCK_PROVIDER_ID = 'bedrock';

/** Cache keyed by YAML filename (empty string = default file). */
const _configs: Map<string, ServerConfig> = new Map();
let _modelListWarningsEmitted = false;

/**
 * AliDocMind is server-configured when AK/SK are provided via env
 * (ALIDOCMIND_ACCESS_KEY_ID/SECRET) or YAML. It uses AK/SK rather than a single
 * apiKey, so it needs its own fallback rather than PDF_ENV_MAP's apiKey shape.
 */
function applyAliDocMindFallback(
  pdfConfig: Record<string, ServerProviderEntry>,
  yamlPdfSection: Record<string, Partial<ServerProviderEntry>> | undefined,
): Record<string, ServerProviderEntry> {
  const yamlEntry = yamlPdfSection?.[ALIDOCMIND_PROVIDER_ID];
  const accessKeyId = process.env.ALIDOCMIND_ACCESS_KEY_ID || yamlEntry?.accessKeyId;
  const accessKeySecret = process.env.ALIDOCMIND_ACCESS_KEY_SECRET || yamlEntry?.accessKeySecret;
  if (!accessKeyId || !accessKeySecret) {
    // AliDocMind can only be server-managed with an AK/SK pair. The generic
    // loader may have created a bare entry from a YAML `baseUrl` alone — drop
    // it so the provider stays UNMANAGED (clients supply their own creds)
    // rather than "managed" with no usable credentials, which would both lock
    // the provider out and silently discard client-entered AK/SK.
    delete pdfConfig[ALIDOCMIND_PROVIDER_ID];
    return pdfConfig;
  }

  // Merge the AK/SK into any entry the generic env/YAML loader already created.
  // That loader copies only apiKey/baseUrl/models/proxy — never AK/SK — and a
  // YAML entry with a `baseUrl` makes it create the entry, so returning early
  // here would leave a "managed" provider with no usable credentials.
  const existing = pdfConfig[ALIDOCMIND_PROVIDER_ID];
  pdfConfig[ALIDOCMIND_PROVIDER_ID] = {
    apiKey: existing?.apiKey ?? '',
    accessKeyId,
    accessKeySecret,
    baseUrl:
      existing?.baseUrl || yamlEntry?.baseUrl || process.env.ALIDOCMIND_BASE_URL || undefined,
    models: existing?.models,
    proxy: existing?.proxy,
  };
  return pdfConfig;
}

/**
 * Server-owned AliDocMind AK/SK, if this deployment manages the provider.
 * Returns undefined when AliDocMind is not server-configured (client must
 * supply its own credentials).
 */
export function resolveManagedAliDocMindCredentials():
  | { accessKeyId: string; accessKeySecret: string; baseUrl?: string }
  | undefined {
  const entry = getConfig().pdf[ALIDOCMIND_PROVIDER_ID];
  if (entry?.accessKeyId && entry?.accessKeySecret) {
    return {
      accessKeyId: entry.accessKeyId,
      accessKeySecret: entry.accessKeySecret,
      baseUrl: entry.baseUrl,
    };
  }
  return undefined;
}

/** Provider-neutral extraction input populated from server-managed media credentials. */
export function resolveServerMediaExtractorConfig(): {
  providerId: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  baseUrl?: string;
  allowEnvFallback: boolean;
} {
  const credentials = resolveManagedAliDocMindCredentials();
  return {
    providerId: '',
    accessKeyId: credentials?.accessKeyId,
    accessKeySecret: credentials?.accessKeySecret,
    baseUrl: credentials?.baseUrl,
    allowEnvFallback: true,
  };
}

function applyOpenAIImageFallback(
  imageConfig: Record<string, ServerProviderEntry>,
  yamlImageSection: Record<string, Partial<ServerProviderEntry>> | undefined,
): Record<string, ServerProviderEntry> {
  if (imageConfig[OPENAI_IMAGE_PROVIDER_ID]) return imageConfig;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return imageConfig;

  const yamlOpenAIImage = yamlImageSection?.[OPENAI_IMAGE_PROVIDER_ID];
  imageConfig[OPENAI_IMAGE_PROVIDER_ID] = {
    apiKey,
    baseUrl:
      yamlOpenAIImage?.baseUrl || process.env.IMAGE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
    models:
      splitModels(process.env.IMAGE_OPENAI_MODELS) ?? normalizeModelList(yamlOpenAIImage?.models),
    proxy: yamlOpenAIImage?.proxy,
  };
  return imageConfig;
}

function splitModels(models: string | undefined): string[] | undefined {
  const parsed = models
    ?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function applyBedrockProviderConfig(
  providers: Record<string, ServerProviderEntry>,
  yamlProviders: Record<string, Partial<ServerProviderEntry>> | undefined,
): Record<string, ServerProviderEntry> {
  const yamlBedrock = yamlProviders?.[BEDROCK_PROVIDER_ID];
  const envApiKey = process.env.BEDROCK_API_KEY || undefined;
  const envBaseUrl = process.env.BEDROCK_BASE_URL || undefined;
  const envRegion = process.env.BEDROCK_REGION?.trim() || undefined;
  const envModels = splitModels(process.env.BEDROCK_MODELS);
  const hasExplicitBedrockEnv =
    !!envRegion ||
    !!envModels ||
    !!envApiKey ||
    !!envBaseUrl ||
    !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  const hasYamlBedrock = Object.prototype.hasOwnProperty.call(
    yamlProviders ?? {},
    BEDROCK_PROVIDER_ID,
  );

  if (!providers[BEDROCK_PROVIDER_ID] && !hasExplicitBedrockEnv && !hasYamlBedrock) {
    return providers;
  }

  providers[BEDROCK_PROVIDER_ID] = {
    apiKey: envApiKey || yamlBedrock?.apiKey || providers[BEDROCK_PROVIDER_ID]?.apiKey || '',
    baseUrl: envBaseUrl || yamlBedrock?.baseUrl || providers[BEDROCK_PROVIDER_ID]?.baseUrl,
    models:
      envModels ||
      normalizeModelList(yamlBedrock?.models) ||
      providers[BEDROCK_PROVIDER_ID]?.models,
    proxy: yamlBedrock?.proxy || providers[BEDROCK_PROVIDER_ID]?.proxy,
  };

  return providers;
}

function buildConfig(yamlData: YamlData): ServerConfig {
  const image = applyOpenAIImageFallback(
    loadEnvSection(IMAGE_ENV_MAP, yamlData.image, {
      keylessProviders: new Set(['lemonade']),
    }),
    yamlData.image,
  );
  const providers = applyBedrockProviderConfig(
    loadEnvSection(LLM_ENV_MAP, yamlData.providers, {
      keylessProviders: new Set(['ollama', 'lemonade', BEDROCK_PROVIDER_ID]),
    }),
    yamlData.providers,
  );

  return {
    providers,
    tts: loadEnvSection(TTS_ENV_MAP, yamlData.tts, {
      keylessProviders: new Set(['voxcpm-tts', 'lemonade-tts']),
    }),
    asr: loadEnvSection(ASR_ENV_MAP, yamlData.asr, {
      keylessProviders: new Set(['funasr-asr', 'lemonade-asr']),
    }),
    pdf: applyAliDocMindFallback(
      loadEnvSection(PDF_ENV_MAP, yamlData.pdf, {
        requiresBaseUrl: true,
        baseUrlOptionalProviders: new Set(['mineru-cloud']),
      }),
      yamlData.pdf,
    ),
    image,
    video: loadEnvSection(VIDEO_ENV_MAP, yamlData.video),
    webSearch: loadEnvSection(WEB_SEARCH_ENV_MAP, yamlData['web-search'], {
      keylessProviders: new Set(['brave', 'searxng']),
    }),
    disabled: collectDisabledProviders(yamlData),
  };
}

function logConfig(config: ServerConfig, label: string): void {
  const counts = [
    Object.keys(config.providers).length,
    Object.keys(config.tts).length,
    Object.keys(config.asr).length,
    Object.keys(config.pdf).length,
    Object.keys(config.image).length,
    Object.keys(config.video).length,
    Object.keys(config.webSearch).length,
  ];
  if (counts.some((c) => c > 0)) {
    log.info(
      `[ServerProviderConfig] Loaded (${label}): ${counts[0]} LLM, ${counts[1]} TTS, ${counts[2]} ASR, ${counts[3]} PDF, ${counts[4]} Image, ${counts[5]} Video, ${counts[6]} WebSearch providers`,
    );
  }
}

function getConfig(): ServerConfig {
  const cached = _configs.get('');
  if (cached) return cached;

  const yamlData = loadYamlFile(DEFAULT_FILENAME);
  const config = buildConfig(yamlData);
  logConfig(config, DEFAULT_FILENAME);
  _configs.set('', config);
  return config;
}

// ---------------------------------------------------------------------------
// Managed-provider resolution
//
// A provider is "server-managed" iff the operator configured it (an entry is
// present in the server config). Managed providers are admin-owned and NOT
// overridable from the client: the server key and base URL are authoritative
// and any client-sent key/baseUrl is ignored. Unmanaged providers (the user's
// own custom credentials) resolve purely from the client value. This single
// rule removes the tri-state where a client base URL could partially override
// server config (the bug class #533 patched route-by-route).
// ---------------------------------------------------------------------------

type ProviderSection = 'providers' | 'tts' | 'asr' | 'pdf' | 'image' | 'video' | 'webSearch';

/**
 * The operator's entry for a provider, or undefined. Provider ids come from
 * requests, so only the section's own keys count: an id such as `constructor`
 * or `__proto__` must not resolve to an inherited object property.
 */
function serverEntry(
  section: ProviderSection,
  providerId: string,
): ServerProviderEntry | undefined {
  const entries = getConfig()[section];
  return Object.hasOwn(entries, providerId) ? entries[providerId] : undefined;
}

/** Whether the operator configured this provider in the given section. */
export function isServerConfiguredProvider(section: ProviderSection, providerId: string): boolean {
  return serverEntry(section, providerId) !== undefined;
}

/** Whether the operator force-disabled this provider in the given capability section (server precedence). */
export function isServerProviderDisabled(section: CapabilitySection, providerId: string): boolean {
  return getConfig().disabled[section].has(providerId);
}

/**
 * Enabled-provider resolver: the provider IDs of a capability listing that
 * this deployment actually serves — present in the listing and not
 * force-disabled (`{ disabled: true }`, #665). The provider-config API
 * deliberately includes force-disabled providers so admin surfaces can show
 * them; every capability consumer (agent tool selectors and gates, server
 * default resolution) must resolve enabledness through this — disable wins.
 */
export function enabledProviderIds<T extends { disabled?: boolean }>(
  listing: Record<string, T>,
): string[] {
  return Object.keys(listing).filter((id) => !listing[id]?.disabled);
}

function resolveSectionApiKey(
  section: ProviderSection,
  providerId: string,
  clientKey?: string,
): string {
  const entry = serverEntry(section, providerId);
  if (entry) return entry.apiKey || ''; // managed: server key is authoritative
  return clientKey || ''; // unmanaged: client-supplied key only
}

function resolveSectionBaseUrl(
  section: ProviderSection,
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  const entry = serverEntry(section, providerId);
  if (entry) return entry.baseUrl; // managed: server base URL is authoritative
  return clientBaseUrl; // unmanaged: client-supplied base URL only
}

// ---------------------------------------------------------------------------
// Public API — LLM
// ---------------------------------------------------------------------------

/**
 * Returns server-configured LLM providers. Exposes only the allowed model list
 * and the "managed" flag (presence in this map) — never the API key or the
 * base URL, which can reveal internal gateway/proxy infrastructure.
 */
export function getServerProviders(): Record<string, { models?: string[] }> {
  const cfg = getConfig();
  const result: Record<string, { models?: string[] }> = {};
  for (const [id, entry] of Object.entries(cfg.providers)) {
    result[id] = {};
    if (entry.models && entry.models.length > 0) result[id].models = entry.models;
  }
  return result;
}

/** Resolve API key. Managed provider ⇒ server key; otherwise client key. */
export function resolveApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('providers', providerId, clientKey);
}

/** Resolve base URL. Managed provider ⇒ server URL; otherwise client URL. */
export function resolveBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('providers', providerId, clientBaseUrl);
}

/** Resolve proxy URL for a provider (server config only) */
export function resolveProxy(providerId: string): string | undefined {
  return serverEntry('providers', providerId)?.proxy;
}

// ---------------------------------------------------------------------------
// Public API — TTS
// ---------------------------------------------------------------------------

/**
 * Returns TTS providers the client must know about: server-managed providers
 * (presence = managed flag, no base URLs) plus operator force-disabled
 * providers (`{ disabled: true }`). A force-disabled provider is reported as
 * disabled even when it is otherwise configured — disable wins (#665).
 */
export function getServerTTSProviders(): Record<string, { disabled?: boolean }> {
  const cfg = getConfig();
  const result: Record<string, { disabled?: boolean }> = {};
  for (const id of Object.keys(cfg.tts)) result[id] = {};
  for (const id of cfg.disabled.tts) result[id] = { disabled: true };
  return result;
}

/**
 * TTS providers this deployment actually serves: present in server config and
 * not force-disabled. Browser-native voices are excluded (no static voice list
 * and no server-side synthesis without a configured backend).
 */
export function enabledServerTTSProviderIds(): string[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
}

export function resolveTTSApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('tts', providerId, clientKey);
}

/** Whether the operator force-disabled this TTS provider (server precedence, #665). */
export function isServerTTSProviderDisabled(providerId: string): boolean {
  return isServerProviderDisabled('tts', providerId);
}

export function resolveTTSBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return (
    resolveSectionBaseUrl('tts', providerId, clientBaseUrl) ||
    TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.defaultBaseUrl
  );
}

/** Resolve the server-only Qwen VC model override without exposing env values to clients. */
export function resolveQwenVoiceCloneModel(): string {
  return process.env.TTS_QWEN_VOICE_CLONE_MODEL?.trim() || DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL;
}

export class TTSModelNotAllowedError extends Error {
  readonly code = 'INVALID_REQUEST';
  readonly httpStatus = 400;

  constructor(providerId: string, modelId: string) {
    super(`Model "${modelId}" is not allowed for provider "${providerId}"`);
    this.name = 'TTSModelNotAllowedError';
  }
}

/**
 * Resolve the requested TTS model against the server list or effective default,
 * then recheck any model selected for voice compatibility. Keyless and BYOK
 * providers retain their existing resolution behavior.
 */
export function resolveTTSModel(
  providerId: string,
  clientModel?: string,
  voiceId?: string,
): string | undefined {
  clientModel = clientModel?.trim() || undefined;
  const entry = serverEntry('tts', providerId);
  if (!usesServerCredentials('tts', providerId, entry))
    return resolveKeylessTTSModel(providerId, clientModel, voiceId);
  const requested = resolveManagedMediaModel('tts', providerId, clientModel);
  let model = requested;
  if (providerId === 'qwen-tts') {
    const vcModel = resolveQwenVoiceCloneModel();
    if (voiceId && !isQwenCatalogVoice(voiceId)) model = vcModel;
    else if (isQwenVoiceCloneModel(requested, vcModel)) {
      model = voiceId
        ? (entry?.models?.find((id) => !isQwenVoiceCloneModel(id, vcModel)) ??
          TTS_PROVIDERS['qwen-tts'].defaultModelId)
        : vcModel;
    }
  }
  // Voice compatibility can select a different model. Check that final target too.
  return resolveManagedMediaModel('tts', providerId, model);
}

// ---------------------------------------------------------------------------
// Public API — ASR
// ---------------------------------------------------------------------------

/**
 * Returns ASR providers the client must know about: server-managed providers
 * (presence = managed flag) plus operator force-disabled providers
 * (`{ disabled: true }`), mirroring the TTS listing — disable wins (#665).
 */
export function getServerASRProviders(): Record<string, { disabled?: boolean }> {
  const cfg = getConfig();
  const result: Record<string, { disabled?: boolean }> = {};
  for (const id of Object.keys(cfg.asr)) result[id] = {};
  for (const id of cfg.disabled.asr) result[id] = { disabled: true };
  return result;
}

export function resolveASRApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('asr', providerId, clientKey);
}

export function resolveASRBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('asr', providerId, clientBaseUrl);
}

/** First operator-configured ASR provider that is not force-disabled. */
export function resolveServerASRProviderId(): string | undefined {
  const cfg = getConfig();
  return Object.keys(cfg.asr).find((id) => !cfg.disabled.asr.has(id));
}

/**
 * Resolve the ASR model. When the operator pinned models server-side
 * (`ASR_<PREFIX>_MODELS`), the authorized client choice wins and the first
 * entry is the managed default; an unlisted choice is refused. BYOK is unrestricted.
 */
export function resolveASRModel(providerId: string, clientModel?: string): string | undefined {
  return resolveManagedMediaModel('asr', providerId, clientModel);
}

// ---------------------------------------------------------------------------
// Public API — PDF
// ---------------------------------------------------------------------------

/** Returns server-configured PDF providers (managed flag only, no base URLs). */
export function getServerPDFProviders(): Record<string, Record<string, never>> {
  return Object.fromEntries(Object.keys(getConfig().pdf).map((id) => [id, {}]));
}

export function resolvePDFApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('pdf', providerId, clientKey);
}

export function resolvePDFBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('pdf', providerId, clientBaseUrl);
}

// ---------------------------------------------------------------------------
// Public API — Image Generation
// ---------------------------------------------------------------------------

/**
 * Returns image providers the client must know about: server-managed providers
 * (allowed models only, no base URLs) plus operator force-disabled providers
 * (`{ disabled: true }`), mirroring the TTS listing — disable wins (#665).
 */
export function getServerImageProviders(): Record<
  string,
  { models?: string[]; disabled?: boolean }
> {
  const cfg = getConfig();
  const result: Record<string, { models?: string[]; disabled?: boolean }> = {};
  for (const [id, entry] of Object.entries(cfg.image)) {
    result[id] = {};
    if (entry.models && entry.models.length > 0) result[id].models = entry.models;
  }
  for (const id of cfg.disabled.image) result[id] = { disabled: true };
  return result;
}

export function resolveImageApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('image', providerId, clientKey);
}

export function resolveImageBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('image', providerId, clientBaseUrl);
}

/**
 * Resolve the server-side default image provider, used when the client sends
 * no provider preference: the first operator-configured image provider that is
 * not force-disabled. Returns undefined when no image provider is enabled at
 * all (callers fail loud).
 */
export function resolveServerImageProviderId(): string | undefined {
  const disabled = getConfig().disabled.image;
  return Object.keys(getConfig().image).find((id) => !disabled.has(id));
}

/**
 * Resolve the image model. When the operator pinned models server-side
 * (`IMAGE_<PREFIX>_MODELS`), the authorized client choice wins and the first
 * entry is the managed default; an unlisted choice is refused. BYOK is unrestricted.
 */
export function resolveImageModel(providerId: string, clientModel?: string): string | undefined {
  return resolveManagedMediaModel('image', providerId, clientModel);
}

// ---------------------------------------------------------------------------
// Public API — Video Generation
// ---------------------------------------------------------------------------

/**
 * Returns video providers the client must know about: server-managed providers
 * (presence = managed flag) plus operator force-disabled providers
 * (`{ disabled: true }`), mirroring the TTS listing — disable wins (#665).
 */
export function getServerVideoProviders(): Record<
  string,
  { models?: string[]; disabled?: boolean }
> {
  const cfg = getConfig();
  const result: Record<string, { models?: string[]; disabled?: boolean }> = {};
  for (const [id, entry] of Object.entries(cfg.video)) {
    result[id] = {};
    if (entry.models && entry.models.length > 0) result[id].models = entry.models;
  }
  for (const id of cfg.disabled.video) result[id] = { disabled: true };
  return result;
}

export function resolveVideoApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('video', providerId, clientKey);
}

export function resolveVideoBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('video', providerId, clientBaseUrl);
}

/**
 * Resolve the server-side default video provider, used when the client sends
 * no provider preference: the first operator-configured video provider that is
 * not force-disabled. Returns undefined when no video provider is enabled at
 * all (callers fail loud).
 */
export function resolveServerVideoProviderId(): string | undefined {
  const disabled = getConfig().disabled.video;
  return Object.keys(getConfig().video).find((id) => !disabled.has(id));
}

/**
 * Resolve the video model. When the operator pinned models server-side
 * (`VIDEO_<PREFIX>_MODELS`), the authorized client choice wins and the first
 * entry is the managed default; an unlisted choice is refused. BYOK is unrestricted.
 */
export function resolveVideoModel(providerId: string, clientModel?: string): string | undefined {
  return resolveManagedMediaModel('video', providerId, clientModel);
}

// ---------------------------------------------------------------------------
// Public API — Web Search
// ---------------------------------------------------------------------------

/**
 * Returns web-search providers the client must know about: server-managed
 * providers (presence = managed flag) plus operator force-disabled providers
 * (`{ disabled: true }`), mirroring the TTS listing — disable wins (#665).
 */
export function getServerWebSearchProviders(): Record<string, { disabled?: boolean }> {
  const cfg = getConfig();
  const result: Record<string, { disabled?: boolean }> = {};
  for (const id of Object.keys(cfg.webSearch)) result[id] = {};
  for (const id of cfg.disabled.webSearch) result[id] = { disabled: true };
  return result;
}

/**
 * Resolve web search API key.
 *
 * Backward-compatible call shapes:
 * - resolveWebSearchApiKey(clientKey) -> Tavily key resolution
 * - resolveWebSearchApiKey(providerId, clientKey) -> provider-specific resolution
 */
export function resolveWebSearchApiKey(clientKey?: string): string;
export function resolveWebSearchApiKey(providerId: string, clientKey?: string): string;
export function resolveWebSearchApiKey(providerIdOrClientKey?: string, clientKey?: string): string {
  const hasProviderId = arguments.length >= 2;
  const providerId = hasProviderId ? providerIdOrClientKey || 'tavily' : 'tavily';
  const effectiveClientKey = hasProviderId ? clientKey : providerIdOrClientKey;
  return resolveSectionApiKey('webSearch', providerId, effectiveClientKey);
}

export function resolveWebSearchBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('webSearch', providerId, clientBaseUrl);
}

/**
 * Resolve the web-search model for model-based providers (currently Claude).
 * A managed provider may pin its model server-side (`${PREFIX}_MODELS`, first
 * entry) — authoritative like its key/baseUrl. Otherwise the client model wins.
 */
export function resolveWebSearchModel(
  providerId: string,
  clientModel?: string,
): string | undefined {
  return resolveManagedMediaModel('webSearch', providerId, clientModel);
}

export function resolveServerWebSearchProviderId(preferredProviderId?: string): string | undefined {
  const webSearch = getConfig().webSearch;
  const disabled = getConfig().disabled.webSearch;
  const enabled = (id: string) => !disabled.has(id);
  if (
    preferredProviderId &&
    enabled(preferredProviderId) &&
    webSearch[preferredProviderId]?.apiKey
  ) {
    return preferredProviderId;
  }
  if (enabled('tavily') && webSearch.tavily?.apiKey) return 'tavily';
  if (enabled('exa') && webSearch.exa?.apiKey) return 'exa';
  if (enabled('bocha') && webSearch.bocha?.apiKey) return 'bocha';
  if (enabled('baidu') && webSearch.baidu?.apiKey) return 'baidu';
  if (enabled('minimax') && webSearch.minimax?.apiKey) return 'minimax';
  if (enabled('claude') && webSearch.claude?.apiKey) return 'claude';
  return Object.keys(webSearch).find(enabled);
}

/**
 * Opt-in concurrency for parallel scene-content generation (#572).
 *
 * Returns the server-configured `PARALLEL_SCENE_CONCURRENCY`, clamped to
 * [0, 10]. `0` (the default) means the client keeps the original serial
 * generation loop; a value `> 1` enables the hybrid two-phase path. Kept
 * server-side because many deployments use API keys with low per-key
 * concurrency quotas, where a bursty default would surface as 429s.
 */
export function getParallelSceneConcurrency(): number {
  const raw = Number.parseInt(process.env.PARALLEL_SCENE_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 10);
}

/** Only a single adapter default is a fallback; the rest of its catalogue grants nothing. */
function mediaDefaultModel(section: ProviderSection, providerId: string): string | undefined {
  if (section === 'tts')
    return TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.defaultModelId || undefined;
  if (section === 'asr')
    return ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS]?.defaultModelId || undefined;
  if (section === 'image')
    return IMAGE_PROVIDERS[providerId as keyof typeof IMAGE_PROVIDERS]?.models?.[0]?.id;
  if (section === 'video')
    return VIDEO_PROVIDERS[providerId as keyof typeof VIDEO_PROVIDERS]?.models?.[0]?.id;
  if (section === 'webSearch' && providerId === 'claude') return CLAUDE_WEB_SEARCH_DEFAULT_MODEL;
  return undefined;
}

function usesServerCredentials(
  section: ProviderSection,
  providerId: string,
  entry?: ServerProviderEntry,
): boolean {
  return Boolean(
    entry && (entry.apiKey || (section === 'providers' && providerId === BEDROCK_PROVIDER_ID)),
  );
}

function selectsModel(section: ProviderSection, providerId: string): boolean {
  // These services send no selected inference model (workflow names are not model ids).
  if (section === 'pdf') return false;
  if (section === 'webSearch') return providerId === 'claude';
  if (section === 'tts')
    return !['azure-tts', 'doubao-tts', 'browser-native-tts'].includes(providerId);
  if (section === 'asr') return !['azure-asr', 'browser-native'].includes(providerId);
  return section !== 'image' || providerId !== 'comfyui-image';
}

function authorizedModels(
  section: ProviderSection,
  providerId: string,
  entry: ServerProviderEntry,
): string[] {
  const models = new Set(entry.models ?? []);
  if (section === 'providers') {
    const references = [
      process.env.DEFAULT_MODEL,
      process.env.MODEL_FALLBACK,
      ...LLM_STAGES.map((stage) => getStageRoute(stage)?.model),
    ];
    for (const reference of references) {
      if (!reference?.trim()) continue;
      const value = reference.trim();
      const colon = value.indexOf(':');
      const id = colon > 0 ? value.slice(0, colon) : 'openai';
      const model = (colon > 0 ? value.slice(colon + 1) : value).trim();
      if (id === providerId && model) models.add(model);
    }
  } else {
    // In 1.1.x the first configured model replaces the adapter's default.
    const model = entry.models?.[0] ?? mediaDefaultModel(section, providerId);
    if (model) models.add(model);
  }
  return [...models];
}

/** Check the model actually selected, using only authoritative server configuration. */
export function authorizeServerModel(
  section: ProviderSection,
  providerId: string,
  modelId: string | undefined,
): void {
  const entry = serverEntry(section, providerId);
  if (!usesServerCredentials(section, providerId, entry) || !selectsModel(section, providerId))
    return;
  if (!modelId || !authorizedModels(section, providerId, entry!).includes(modelId)) {
    throw new ModelAuthorizationError();
  }
}

function resolveManagedMediaModel(
  section: CapabilitySection,
  providerId: string,
  clientModel?: string,
): string | undefined {
  clientModel = clientModel?.trim() || undefined;
  const entry = serverEntry(section, providerId);
  if (!usesServerCredentials(section, providerId, entry) || !selectsModel(section, providerId)) {
    // Preserve keyless/BYOK resolution, including operator pins on keyless providers.
    if (entry?.models?.length) {
      if (
        ['asr', 'image', 'video'].includes(section) &&
        clientModel &&
        entry.models.includes(clientModel)
      )
        return clientModel;
      return entry.models[0];
    }
    return clientModel;
  }
  const model = clientModel ?? entry?.models?.[0] ?? mediaDefaultModel(section, providerId);
  authorizeServerModel(section, providerId, model);
  return model;
}

/** Emit only from boot validation: Next loads a separate copy of this module for routes. */
export function warnMissingServerModelLists(): void {
  if (_modelListWarningsEmitted) return;
  const config = getConfig();
  _modelListWarningsEmitted = true;
  warnMissingModelLists(config);
}

function warnMissingModelLists(config: ServerConfig): void {
  const maps = {
    providers: LLM_ENV_MAP,
    tts: TTS_ENV_MAP,
    asr: ASR_ENV_MAP,
    pdf: PDF_ENV_MAP,
    image: IMAGE_ENV_MAP,
    video: VIDEO_ENV_MAP,
    webSearch: WEB_SEARCH_ENV_MAP,
  };
  for (const section of Object.keys(maps) as ProviderSection[]) {
    for (const [providerId, entry] of Object.entries(config[section])) {
      if (
        !usesServerCredentials(section, providerId, entry) ||
        !selectsModel(section, providerId) ||
        entry.models?.length
      )
        continue;
      const prefix = Object.entries(maps[section]).find(([, id]) => id === providerId)?.[0];
      const yamlSection = section === 'webSearch' ? 'web-search' : section;
      const setting = `${prefix ? `${prefix}_MODELS or ` : ''}server-providers.yml ${yamlSection}.${providerId}.models`;
      log.warn(
        `[config] Set ${setting} for server-managed model selection; only deployment default/fallback models are authorized without an explicit list.`,
      );
    }
  }
}

function resolveKeylessTTSModel(
  providerId: string,
  clientModel?: string,
  voiceId?: string,
): string | undefined {
  const entry = serverEntry('tts', providerId);
  const pinnedModels = entry?.models?.filter(Boolean) ?? [];

  if (providerId === 'qwen-tts') {
    const vcModel = resolveQwenVoiceCloneModel();
    const requestedIsVCSentinel = !!clientModel && isQwenVoiceCloneModel(clientModel, vcModel);
    const normalizedClientModel = requestedIsVCSentinel ? vcModel : clientModel;
    const allowedModels = new Set([...pinnedModels, vcModel]);

    if (
      pinnedModels.length > 0 &&
      normalizedClientModel &&
      !allowedModels.has(normalizedClientModel)
    ) {
      throw new TTSModelNotAllowedError(providerId, normalizedClientModel);
    }

    if (voiceId) {
      if (!isQwenCatalogVoice(voiceId)) return vcModel;
      const pinnedCatalogModel = pinnedModels.find((model) => model !== vcModel);
      if (pinnedModels.length > 0 && !pinnedCatalogModel) {
        throw new TTSModelNotAllowedError(providerId, TTS_PROVIDERS['qwen-tts'].defaultModelId);
      }
      // Self-heal persisted VC-model + catalog-voice wedges. Prefer the first
      // operator-pinned non-VC model, otherwise the catalog default.
      if (normalizedClientModel === vcModel) {
        return pinnedCatalogModel || TTS_PROVIDERS['qwen-tts'].defaultModelId;
      }
    }

    if (normalizedClientModel) return normalizedClientModel;
    if (pinnedModels.length > 0) return pinnedModels[0];
    return undefined;
  }

  if (pinnedModels.length > 0) return pinnedModels[0];
  return clientModel;
}
