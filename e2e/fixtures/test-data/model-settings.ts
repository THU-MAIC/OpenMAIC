/**
 * The workspace model settings the app reads from `GET /api/model-config`
 * (lib/server/model-config/settings.ts). The browser keeps no provider state:
 * whether a language model is set up, which one the course uses and which
 * media is available all come from this view, so specs answer it.
 */

/** The capability slots, as `lib/config/model-slots.ts` declares them. */
const SLOTS: Array<{ slot: string; parent: string | null; capability: string }> = [
  { slot: 'llm', parent: null, capability: 'chat' },
  { slot: 'course.research', parent: 'llm', capability: 'chat' },
  { slot: 'course.outline', parent: 'llm', capability: 'chat' },
  { slot: 'course.agents', parent: 'llm', capability: 'chat' },
  { slot: 'course.content', parent: 'llm', capability: 'chat' },
  { slot: 'course.content.slide', parent: 'course.content', capability: 'chat' },
  { slot: 'course.content.quiz', parent: 'course.content', capability: 'chat' },
  { slot: 'course.content.interactive', parent: 'course.content', capability: 'chat' },
  { slot: 'course.content.pbl', parent: 'course.content', capability: 'chat' },
  { slot: 'course.actions', parent: 'llm', capability: 'chat' },
  { slot: 'classroom', parent: 'llm', capability: 'chat' },
  { slot: 'agent', parent: 'llm', capability: 'chat' },
  { slot: 'agent.title', parent: 'agent', capability: 'chat' },
  { slot: 'tts', parent: null, capability: 'tts' },
  { slot: 'asr', parent: null, capability: 'asr' },
  { slot: 'image', parent: null, capability: 'image' },
  { slot: 'video', parent: null, capability: 'video' },
  { slot: 'webSearch', parent: null, capability: 'webSearch' },
  { slot: 'document', parent: null, capability: 'document' },
];

/** Display names of the chat presets these specs use. */
const PRESET_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Gemini',
};

export interface ModelSettingsOptions {
  /** Chat providers (preset id = provider id) and the models each offers. */
  providers?: Record<string, string[]>;
  /** The course model, `provider:model`; omitted: no language model. */
  llm?: string;
  /** Whether the deployment locks llm (and so every language model slot under it). */
  locked?: boolean;
  /** Media roots that resolve to a provider (registry ids). */
  media?: Partial<Record<'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'document', string>>;
}

export type ModelSettingsView = ReturnType<typeof createModelSettingsView>;

/** A view with the given course model and providers; every other slot follows or is unassigned. */
export function createModelSettingsView(options: ModelSettingsOptions = {}) {
  const providers = options.providers ?? {};
  const [llmProvider, ...rest] = (options.llm ?? '').split(':');
  const llmModel = rest.join(':');
  const target = (providerId: string, registryId: string, modelId?: string) => ({
    providerId,
    providerSource: 'deployment',
    presetId: registryId,
    registryId,
    ...(modelId ? { modelId } : {}),
  });
  return {
    revision: 1 as number | null,
    allowUserKeys: true,
    presets: Object.keys(providers).map((id) => ({
      id,
      name: PRESET_NAMES[id] ?? id,
      kind: 'single',
      capabilities: { chat: { models: [] } },
      requiresBaseUrl: false,
      customEndpoint: true,
      recommended: {},
    })),
    providers: Object.entries(providers).map(([id, models]) => ({
      id,
      preset: id,
      presetName: PRESET_NAMES[id] ?? id,
      presetKind: 'single',
      source: 'workspace',
      capabilities: { chat: { models: models.map((model) => ({ id: model, name: model })) } },
      key: { set: true, mask: '…' },
    })),
    slots: SLOTS.map(({ slot, parent, capability }) => {
      const locked = capability === 'chat' && !!options.locked;
      let effective: Record<string, unknown> = { status: 'unassigned' };
      let source: Record<string, unknown> = { kind: 'unconfigured' };
      if (capability === 'chat' && llmProvider) {
        const from = locked ? 'locked' : 'workspace';
        effective = {
          status: 'assigned',
          resolvedAt: 'llm',
          source: from,
          requirements: [],
          ...target(llmProvider, llmProvider, llmModel),
        };
        source = slot === 'llm' ? { kind: from } : { kind: 'inherited', from: 'llm' };
      }
      const media = options.media?.[slot as keyof NonNullable<ModelSettingsOptions['media']>];
      if (media) {
        effective = {
          status: 'assigned',
          resolvedAt: slot,
          source: 'default',
          requirements: [],
          ...target(media, media),
        };
        source = { kind: 'default' };
      }
      return {
        slot,
        parent,
        capability,
        configOnly: slot === 'agent.title',
        locked,
        source,
        ...(slot === 'llm' && options.llm && !locked ? { assignment: options.llm } : {}),
        effective,
      };
    }),
  };
}

/** The view the specs start from: OpenAI's gpt-4o as the course model. */
export const DEFAULT_MODEL_SETTINGS: ModelSettingsOptions = {
  providers: { openai: ['gpt-4o', 'gpt-4o-mini'] },
  llm: 'openai:gpt-4o',
};
