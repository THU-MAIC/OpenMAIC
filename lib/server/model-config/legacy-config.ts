/**
 * Legacy model configuration → the model configuration of RFC #1701 (#1725).
 *
 * Existing deployments configure providers through environment variables and
 * `server-providers.yml`, the default model through `DEFAULT_MODEL`, per-stage
 * models through `MODEL_ROUTES`, and a retry model through `MODEL_FALLBACK` or a
 * route's `fallback`. This translates all of that into the same shape as
 * `openmaic.yml`, so it can serve as the deployment layer for `resolveSlot`.
 *
 * The translation is lenient: anything that does not carry over cleanly (a
 * default model whose provider has no server credentials, stages that now share
 * one slot but name different models) becomes a notice and is left out, never a
 * startup failure. Until routes resolve through slots (P1 in #1725) the legacy
 * paths keep serving requests unchanged.
 */
import { parseModelString } from '@/lib/ai/providers';
import {
  MODEL_SLOTS,
  STAGE_SLOTS,
  getSlot,
  isSlotId,
  type SlotCapability,
  type SlotId,
} from '@/lib/config/model-slots';
import { PRESET_ID_OVERRIDES, getProviderPreset } from '@/lib/config/provider-presets';
import type { ModelConfigFile, SlotAssignment } from '@/lib/server/model-config/openmaic-yml';
import type { LlmStage, StageRoute } from '@/lib/server/model-routes';
import type { ServerConfig, ServerProviderEntry } from '@/lib/server/provider-config';

/**
 * Stage keys no call site resolves a model with (see STAGE_SLOTS): they carry
 * no behavior to preserve, so they do not take part in slot agreement.
 */
const UNRESOLVED_STAGES: ReadonlySet<LlmStage> = new Set(['pbl-chat', 'maic-agent']);

export interface LegacyModelSettings {
  /** `DEFAULT_MODEL`. */
  defaultModel?: string;
  /**
   * The route each stage actually uses under `MODEL_ROUTES`, after a composite
   * key falls back to its base key (`scene-content:slide` → `scene-content`).
   */
  stageRoutes?: Partial<Record<LlmStage, StageRoute>>;
  /** `MODEL_FALLBACK`: one retry model for every chat stage without its own. */
  globalFallback?: string;
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

export function translateLegacyConfig(
  server: Readonly<ServerConfig>,
  settings: LegacyModelSettings = {},
): LegacyTranslation {
  const notices: string[] = [];
  const providers: NonNullable<ModelConfigFile['providers']> = {};

  for (const section of Object.keys(SECTION_CAPABILITY) as Section[]) {
    const capability = SECTION_CAPABILITY[section];
    const disabled = DISABLE_SECTION[section] ? server.disabled[DISABLE_SECTION[section]!] : null;
    for (const [registryId, entry] of Object.entries(server[section])) {
      if (disabled?.has(registryId)) {
        notices.push(
          `${section}.${registryId} is disabled by the operator and is not carried over`,
        );
        continue;
      }
      const id = legacyProviderId(capability, registryId);
      const preset = getProviderPreset(id);
      if (!preset || preset.capabilities[capability]?.registryId !== registryId) {
        notices.push(`${section}.${registryId} has no matching preset and is not carried over`);
        continue;
      }
      providers[id] = translateProvider(entry, id);
    }
  }

  /** A chat model string as a reference to a declared provider, or undefined. */
  const chatRef = (modelString: string, what: string): string | undefined => {
    const { providerId, modelId } = parseModelString(modelString);
    const id = legacyProviderId('chat', providerId);
    if (!Object.hasOwn(providers, id)) {
      notices.push(
        `${what} uses provider "${providerId}", which has no server configuration; it is left to the browser`,
      );
      return undefined;
    }
    return `${id}:${modelId}`;
  };

  const slots: Partial<Record<SlotId, SlotAssignment>> = {};

  if (settings.defaultModel) {
    const ref = chatRef(settings.defaultModel, 'DEFAULT_MODEL');
    if (ref) slots.llm = ref;
  }

  // Routes, by the slot their stage now belongs to. A slot gets an assignment
  // only when every stage it serves uses the same route: a slot whose stages
  // mix a route with the default model cannot be expressed and is reported.
  const stageRoutes = settings.stageRoutes ?? {};
  const bySlot = new Map<SlotId, LlmStage[]>();
  for (const stage of Object.keys(STAGE_SLOTS) as LlmStage[]) {
    if (UNRESOLVED_STAGES.has(stage)) continue;
    const slot = STAGE_SLOTS[stage];
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), stage]);
  }
  const routed = new Map<SlotId, SlotAssignment | undefined>();
  const conflicted = new Set<SlotId>();
  for (const [slot, stages] of bySlot) {
    const routes = stages.map((stage) => stageRoutes[stage]);
    if (routes.every((route) => !route)) continue;
    const keys = new Set(routes.map((route) => (route ? JSON.stringify(route) : 'default')));
    if (keys.size > 1) {
      notices.push(
        `MODEL_ROUTES gives the stages that now share the slot ${slot} different models (${stages.join(', ')}); set it in openmaic.yml`,
      );
      conflicted.add(slot);
      continue;
    }
    const route = routes[0]!;
    const model = chatRef(route.model, `MODEL_ROUTES (${stages.join(', ')})`);
    if (!model) {
      // Left to the browser, like the stages' default model below.
      routed.set(slot, undefined);
      continue;
    }
    const fallback = route.fallback
      ? chatRef(route.fallback, `MODEL_ROUTES (${stages.join(', ')}) fallback`)
      : undefined;
    const options = {
      ...(route.thinking ? { thinking: route.thinking } : {}),
      ...(fallback ? { fallback } : {}),
      ...(route.api ? { api: route.api } : {}),
      ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}),
    };
    routed.set(
      slot,
      Object.keys(options).length ? ({ model, ...options } as SlotAssignment) : model,
    );
  }

  // generate-classroom's route is the browserless API's model; the llm root is
  // also every unrouted stage's default, which is DEFAULT_MODEL.
  const defaultModel = slots.llm;
  const classroomRoute = routed.get('llm');
  if (routed.has('llm') && defaultModel === undefined) {
    if (classroomRoute !== undefined) slots.llm = classroomRoute;
  } else if (routed.has('llm') && JSON.stringify(classroomRoute) !== JSON.stringify(defaultModel)) {
    notices.push(
      'MODEL_ROUTES.generate-classroom differs from DEFAULT_MODEL; DEFAULT_MODEL is kept for the llm slot',
    );
  }

  // Every other slot that serves stages gets what those stages used: their
  // route, or else the default model. It is written only where inheritance
  // would give something else, so an unrouted stage under a routed parent
  // stays on the default model. MODEL_SLOTS lists parents before children.
  const inherited = (slot: SlotId): SlotAssignment | undefined => {
    for (let parent = getSlot(slot).parent as SlotId | null; parent; ) {
      if (slots[parent] !== undefined) return slots[parent];
      parent = getSlot(parent).parent as SlotId | null;
    }
    return undefined;
  };
  const browserOnly: SlotId[] = [];
  for (const { id: slot } of MODEL_SLOTS) {
    if (slot === 'llm' || !bySlot.has(slot) || conflicted.has(slot)) continue;
    const used = routed.has(slot) ? routed.get(slot) : defaultModel;
    if (JSON.stringify(used) === JSON.stringify(inherited(slot))) continue;
    if (used === undefined) browserOnly.push(slot);
    else slots[slot] = used;
  }
  if (browserOnly.length) {
    notices.push(
      `${browserOnly.join(', ')} used the browser's model and now inherit a server model; set them in openmaic.yml to change that`,
    );
  }

  // MODEL_FALLBACK applies to every chat assignment without its own fallback.
  if (settings.globalFallback) {
    const fallback = chatRef(settings.globalFallback, 'MODEL_FALLBACK');
    if (fallback) {
      if (slots.llm === undefined) {
        notices.push('MODEL_FALLBACK has no DEFAULT_MODEL to attach to on the llm slot');
      }
      for (const [slot, assignment] of Object.entries(slots) as [SlotId, SlotAssignment][]) {
        if (assignment === null || !isSlotId(slot) || getSlot(slot).capability !== 'chat') continue;
        if (typeof assignment === 'string') {
          slots[slot] = { model: assignment, fallback };
        } else if (!assignment.fallback) {
          slots[slot] = { ...assignment, fallback };
        }
      }
    }
  }

  const config: ModelConfigFile = {};
  if (Object.keys(providers).length) config.providers = providers;
  if (Object.keys(slots).length) config.slots = slots as ModelConfigFile['slots'];
  return { config, notices };
}
