/**
 * Official regional endpoints (RFC #1701, tracked in #1725).
 *
 * A few services have no single endpoint: the registry's default names the
 * region as a placeholder (`https://{region}.tts.speech.microsoft.com`), so a
 * provider of that preset has to say which region it uses. Such an endpoint is
 * still the vendor's own, not a custom one: a workspace may set it, and media
 * resolution treats it like the preset's default. Anything that does not
 * match the official host exactly stays a custom endpoint, which only the
 * deployment may configure.
 *
 * Shared by the server (save-time and resolution checks) and the browser (the
 * settings form and the one-time import of browser settings).
 */
import type { SlotCapability } from '@/lib/config/model-slots';

interface RegionalEndpoint {
  /** The endpoint as the settings show it, with `<region>` for the region. */
  template: string;
  /** The official hosts: `<region>.<suffix>` with the region `[a-z0-9]+`. */
  host: RegExp;
}

const REGIONAL_ENDPOINTS: Partial<Record<SlotCapability, Record<string, RegionalEndpoint>>> = {
  tts: {
    'azure-tts': {
      template: 'https://<region>.tts.speech.microsoft.com',
      host: /^[a-z0-9]+\.tts\.speech\.microsoft\.com$/,
    },
  },
  asr: {
    // The speech-to-text host and the Cognitive Services one serve the same
    // region (the adapter maps the former onto the latter).
    'azure-asr': {
      template: 'https://<region>.api.cognitive.microsoft.com',
      host: /^[a-z0-9]+\.(?:api\.cognitive|stt\.speech)\.microsoft\.com$/,
    },
  },
};

/**
 * `https://host` with an optional trailing slash and nothing else: no
 * userinfo, port, path, query, fragment, backslash or whitespace. Checked on
 * the text as typed, before the URL parser normalises any of it away.
 */
const BARE_HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+\/?$/;

function regionalEndpoint(
  capability: SlotCapability,
  registryId: string,
): RegionalEndpoint | undefined {
  const entries = REGIONAL_ENDPOINTS[capability];
  return entries && Object.hasOwn(entries, registryId) ? entries[registryId] : undefined;
}

/** The template of a service whose official endpoint is per region, else undefined. */
export function regionalEndpointTemplate(
  capability: SlotCapability,
  registryId: string,
): string | undefined {
  return regionalEndpoint(capability, registryId)?.template;
}

/**
 * The official regional endpoint `url` names for this service, normalised to
 * `https://<host>`, or undefined when it is not one (or the service has no
 * regional endpoints).
 */
export function officialRegionalEndpoint(
  capability: SlotCapability,
  registryId: string,
  url: string,
): string | undefined {
  const entry = regionalEndpoint(capability, registryId);
  if (!entry || typeof url !== 'string' || !BARE_HTTPS_ORIGIN.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  return entry.host.test(host) ? `https://${host}` : undefined;
}

interface PresetLike {
  capabilities: Partial<Record<SlotCapability, { registryId: string }>>;
}

/**
 * The regional endpoint template of a preset, when every capability it
 * offers has one (Azure Speech's single-capability presets), else undefined.
 */
export function presetRegionalEndpointTemplate(preset: PresetLike): string | undefined {
  const targets = Object.entries(preset.capabilities) as [SlotCapability, { registryId: string }][];
  if (!targets.length) return undefined;
  const templates = targets.map(([capability, target]) =>
    regionalEndpointTemplate(capability, target.registryId),
  );
  return templates.every(Boolean) ? templates[0] : undefined;
}

/**
 * The normalised official endpoint `url` names for a preset: one every
 * capability the preset offers accepts as its official regional endpoint,
 * else undefined.
 */
export function presetOfficialRegionalEndpoint(
  preset: PresetLike,
  url: string,
): string | undefined {
  const targets = Object.entries(preset.capabilities) as [SlotCapability, { registryId: string }][];
  if (!targets.length) return undefined;
  let normalized: string | undefined;
  for (const [capability, target] of targets) {
    const official = officialRegionalEndpoint(capability, target.registryId, url);
    if (!official || (normalized !== undefined && normalized !== official)) return undefined;
    normalized = official;
  }
  return normalized;
}
