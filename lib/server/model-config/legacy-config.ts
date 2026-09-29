/**
 * Legacy model configuration → the model configuration of RFC #1701 (#1725).
 *
 * Existing deployments configure providers through environment variables and
 * `server-providers.yml`, the default model through `DEFAULT_MODEL`, per-stage
 * models through `MODEL_ROUTES`, and a retry model through `MODEL_FALLBACK` or a
 * route's `fallback`. This translates all of that into the same shape as
 * `openmaic.yml`, so it can serve as the deployment layer for `resolveSlot`.
 *
 * The goal is that every stage resolves to what it uses today. The translation
 * is lenient: anything that cannot be expressed (stages that now share one slot
 * but name different models, a model whose provider has no server credentials,
 * a value the new schema rejects) becomes a notice and is left out, never a
 * startup failure. Notices never repeat configured values, only registry ids
 * and configuration names. Until routes resolve through slots (P1 in #1725) the
 * legacy paths keep serving requests unchanged.
 */
import { PROVIDERS, parseModelString } from '@/lib/ai/providers';
import {
  MODEL_SLOTS,
  STAGE_SLOTS,
  getSlot,
  type SlotCapability,
  type SlotId,
} from '@/lib/config/model-slots';
import { PRESET_ID_OVERRIDES, getProviderPreset } from '@/lib/config/provider-presets';
import {
  providerSchema,
  thinkingSchema,
  type ModelConfigFile,
  type SlotAssignment,
} from '@/lib/server/model-config/openmaic-yml';
import type { LlmStage, StageRoute } from '@/lib/server/model-routes';
import type { ServerConfig, ServerProviderEntry } from '@/lib/server/provider-config';

/**
 * Stage keys no call site resolves a model with (see STAGE_SLOTS): they carry
 * no behavior to preserve, so they do not take part in slot agreement.
 */
const UNRESOLVED_STAGES: ReadonlySet<LlmStage> = new Set(['pbl-chat', 'maic-agent']);

/** Slots with call-site rules of their own, translated separately below. */
const AGENT_SLOTS: ReadonlySet<SlotId> = new Set(['agent', 'agent.title']);

/** The pi transports the agent driver accepts (lib/server/agent-runtime/agent-driver-model.ts). */
const DRIVER_APIS: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses']);

export interface LegacyModelSettings {
  /** `DEFAULT_MODEL`. */
  defaultModel?: string;
  /**
   * The route each stage actually uses under `MODEL_ROUTES`, after a composite
   * key falls back to its base key (`scene-content:slide` → `scene-content`).
   */
  stageRoutes?: Partial<Record<LlmStage, StageRoute>>;
  /** `MODEL_FALLBACK`: the retry model for every chat stage without its own. */
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

/** Field names a schema rejected, never their values. */
function rejectedFields(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string {
  const fields = new Set(
    error.issues.map((issue) => issue.path.map(String).join('.') || '(entry)'),
  );
  return [...fields].join(', ');
}

/** What `providerId:modelId` looks like in openmaic.yml (no line breaks in the model id). */
const MODEL_REF_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}:.+$/;

/** A registry id with a preset for this capability, safe to name in a notice. */
function isKnown(capability: SlotCapability, registryId: string): boolean {
  const preset = getProviderPreset(legacyProviderId(capability, registryId));
  return preset?.capabilities[capability]?.registryId === registryId;
}

/** A model string as the legacy code resolves it: a bare id means openai. */
function normalRef(modelString: string): string {
  const { providerId, modelId } = parseModelString(modelString);
  return `${providerId}:${modelId}`;
}

/**
 * What a route changes for a callLLM stage: model, thinking and retry model
 * (its own fallback, else MODEL_FALLBACK). api and contextWindow are inert there.
 */
function routeKey(route: StageRoute, globalFallback: string | undefined): string {
  const fallback = route.fallback ?? globalFallback;
  return JSON.stringify([
    normalRef(route.model),
    route.thinking ?? null,
    fallback ? normalRef(fallback) : null,
  ]);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const globalFallback = settings.globalFallback
    ? chatRef(settings.globalFallback, 'MODEL_FALLBACK')
    : undefined;

  /**
   * The assignment a stage group uses today: its model, the route's options
   * (driver options only on the agent), and its retry model, which is the
   * route's own fallback when it names one (even one that cannot carry over:
   * that stage never retries on MODEL_FALLBACK) and MODEL_FALLBACK otherwise.
   */
  const assignment = (
    model: string,
    route: StageRoute | undefined,
    what: string,
    { driver = false, thinkingDefault }: { driver?: boolean; thinkingDefault?: object } = {},
  ): SlotAssignment => {
    let thinking: object | undefined = route?.thinking ?? thinkingDefault;
    if (thinking) {
      const checked = thinkingSchema.safeParse(thinking);
      if (!checked.success) {
        notices.push(
          `${what}: thinking is not carried over (invalid ${rejectedFields(checked.error)})`,
        );
        thinking = thinkingDefault;
      }
    }
    const fallback = driver
      ? undefined
      : route?.fallback
        ? chatRef(route.fallback, `${what} fallback`)
        : globalFallback;
    let contextWindow = driver ? route?.contextWindow : undefined;
    if (contextWindow !== undefined && !(Number.isInteger(contextWindow) && contextWindow > 0)) {
      notices.push(`${what}: contextWindow is not carried over (not a positive integer)`);
      contextWindow = undefined;
    }
    const options = {
      ...(thinking ? { thinking } : {}),
      ...(fallback ? { fallback } : {}),
      ...(driver && route?.api ? { api: route.api } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    return Object.keys(options).length ? ({ model, ...options } as SlotAssignment) : model;
  };

  const slots: Partial<Record<SlotId, SlotAssignment>> = {};
  const stageRoutes = settings.stageRoutes ?? {};

  // DEFAULT_MODEL is the llm root and so every unrouted stage's model.
  const defaultRef = settings.defaultModel
    ? chatRef(settings.defaultModel, 'DEFAULT_MODEL')
    : undefined;
  const defaultModel = defaultRef ? assignment(defaultRef, undefined, 'DEFAULT_MODEL') : undefined;
  if (defaultModel !== undefined) slots.llm = defaultModel;
  else if (globalFallback) {
    notices.push(
      'MODEL_FALLBACK also covered stages on the browser’s model; without DEFAULT_MODEL it only applies to routed stages',
    );
  }

  // Routes, by the slot their stage now belongs to. A slot has a route only
  // when every stage it serves uses the same one: a slot whose stages mix
  // routes (or a route with the default model) cannot be expressed.
  const bySlot = new Map<SlotId, LlmStage[]>();
  for (const stage of Object.keys(STAGE_SLOTS) as LlmStage[]) {
    if (UNRESOLVED_STAGES.has(stage)) continue;
    const slot = STAGE_SLOTS[stage];
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), stage]);
  }
  // A value of undefined: routed to a model that stays with the browser.
  // An unrouted stage behaves like a route to DEFAULT_MODEL with no options.
  const defaultKey = settings.defaultModel
    ? routeKey({ model: settings.defaultModel }, settings.globalFallback)
    : 'browser';
  const routed = new Map<SlotId, SlotAssignment | undefined>();
  const conflicted = new Set<SlotId>();
  for (const [slot, stages] of bySlot) {
    if (AGENT_SLOTS.has(slot)) continue;
    const routes = stages.map((stage) => stageRoutes[stage]);
    const keys = new Set(
      routes.map((route) => (route ? routeKey(route, settings.globalFallback) : defaultKey)),
    );
    if (keys.size === 1 && keys.has(defaultKey)) continue;
    if (keys.size > 1) {
      notices.push(
        `MODEL_ROUTES gives the stages that now share the slot ${slot} different models (${stages.join(', ')}); set it in openmaic.yml`,
      );
      conflicted.add(slot);
      continue;
    }
    const route = routes.find((candidate) => candidate)!;
    const what = `MODEL_ROUTES (${stages.join(', ')})`;
    const model = chatRef(route.model, what);
    routed.set(slot, model ? assignment(model, route, what) : undefined);
  }

  // generate-classroom's route is the browserless API's model; the llm root is
  // also every unrouted stage's default, so DEFAULT_MODEL wins there.
  if (routed.has('llm')) {
    const classroom = routed.get('llm');
    if (defaultModel === undefined) {
      if (classroom !== undefined) slots.llm = classroom;
    } else if (!same(classroom, defaultModel)) {
      notices.push(
        'MODEL_ROUTES.generate-classroom differs from DEFAULT_MODEL; DEFAULT_MODEL is kept for the llm slot',
      );
    }
  }

  // Every other slot that serves stages gets what those stages use today:
  // their route, or else the default model. It is written only where
  // inheritance would give something else, so an unrouted stage under a routed
  // parent stays on the default model. MODEL_SLOTS lists parents first.
  const inherited = (slot: SlotId): SlotAssignment | undefined => {
    for (let parent = getSlot(slot).parent as SlotId | null; parent; ) {
      if (slots[parent] !== undefined) return slots[parent];
      parent = getSlot(parent).parent as SlotId | null;
    }
    return undefined;
  };
  const browserOnly: SlotId[] = [];
  for (const { id: slot } of MODEL_SLOTS) {
    if (slot === 'llm' || AGENT_SLOTS.has(slot) || !bySlot.has(slot) || conflicted.has(slot)) {
      continue;
    }
    const used = routed.has(slot) ? routed.get(slot) : defaultModel;
    if (same(used, inherited(slot))) continue;
    if (used === undefined) browserOnly.push(slot);
    else slots[slot] = used;
  }
  if (browserOnly.length) {
    notices.push(
      `${browserOnly.join(', ')} used the browser's model and now inherit a server model; set them in openmaic.yml to change that`,
    );
  }

  // Retries now follow the slot. Today some calls pick their retry model by
  // another label than their model, and some never retry (streaming, calls
  // outside server-managed routing); rather than list every call site, say so
  // whenever a retry model is configured.
  if (
    settings.globalFallback ||
    Object.values(stageRoutes).some((route) => route?.fallback !== undefined)
  ) {
    notices.push(
      "Retry models now follow the slot: every call retries on its slot's fallback, where today some calls retry on another stage's fallback or not at all; check the fallbacks in the translated configuration",
    );
  }

  // The agent driver never uses DEFAULT_MODEL: it needs its own route with a
  // provider prefix, a supported transport and no thinking effort, and is
  // unavailable otherwise. That is written as null only where the agent would
  // otherwise inherit a server model; with no server model it stays open.
  const driverRoute = stageRoutes['maic-agent-driver'];
  let driver: SlotAssignment | undefined = inherited('agent') === undefined ? undefined : null;
  if (driverRoute) {
    const what = 'MODEL_ROUTES (maic-agent-driver)';
    const problem =
      driverRoute.model.indexOf(':') <= 0
        ? 'its model has no provider prefix'
        : !driverRoute.api || !DRIVER_APIS.has(driverRoute.api)
          ? 'its api is not openai-completions or openai-responses'
          : driverRoute.thinking?.effort !== undefined
            ? 'it sets thinking.effort'
            : undefined;
    if (problem) {
      notices.push(`${what} is not usable today (${problem}); the agent slot stays off`);
    } else {
      const model = chatRef(driverRoute.model, what);
      if (model) driver = assignment(model, driverRoute, what, { driver: true });
    }
  }
  if (driver !== undefined) slots.agent = driver;

  // Conversation titles use their own route, or else the driver's model; either
  // way thinking is off unless the route says otherwise.
  const titleRoute = stageRoutes['conversation-title'];
  const what = 'MODEL_ROUTES (conversation-title)';
  const titleModel = titleRoute
    ? chatRef(titleRoute.model, what)
    : driver === null || driver === undefined
      ? undefined
      : typeof driver === 'string'
        ? driver
        : driver.model;
  if (titleModel) {
    slots['agent.title'] = assignment(titleModel, titleRoute, what, {
      thinkingDefault: { mode: 'disabled' },
    });
  }

  const config: ModelConfigFile = {};
  if (Object.keys(providers).length) config.providers = providers;
  if (Object.keys(slots).length) config.slots = slots as ModelConfigFile['slots'];
  return { config, notices };
}
