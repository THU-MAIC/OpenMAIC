/**
 * The model settings a workspace sees and edits (RFC #1701, tracked in #1725,
 * P2). This is the service behind `/api/model-config`: it reads the slot tree
 * with each slot's effective model, where it comes from and whether it is
 * locked, and applies changes to the workspace layer.
 *
 * Keys are write-only: a view carries a mask and whether a key is set, never
 * the key. Deployment providers (openmaic.yml, or the legacy server
 * configuration) are listed without anything about their credentials, and are
 * read-only. Every change is validated against the whole configuration before
 * it is stored, so a stored workspace configuration always resolves.
 */
import { z } from 'zod';

import {
  MODEL_SLOTS,
  getSlot,
  isSlotId,
  type SlotCapability,
  type SlotId,
} from '@/lib/config/model-slots';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  presetModels,
  registryDefaultBaseUrl,
  type CatalogueModel,
  type ProviderPreset,
} from '@/lib/config/provider-presets';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';

import { isLocalEndpoint } from './media';
import { checkModelConfigShape, type ModelConfigFile, type SlotAssignment } from './openmaic-yml';
import {
  resolveSlot,
  SlotResolutionError,
  type ModelConfigLayer,
  type ResolvedModelTarget,
  type SlotResolution,
} from './resolve-slot';
import { deploymentConfig, lookupFromLayers } from './runtime';

type Provider = NonNullable<ModelConfigFile['providers']>[string];

export interface ProviderView {
  id: string;
  preset: string;
  /** Where it is declared: deployment providers are read-only. */
  source: 'deployment' | 'workspace';
  baseUrl?: string;
  models?: string[];
  /** What it offers, with the models to pick from per capability. */
  capabilities: CapabilityModels;
  /** Workspace providers only. */
  key?: { set: boolean; mask?: string; unreadable?: boolean };
}

export type CapabilityModels = Partial<Record<SlotCapability, { models: CatalogueModel[] }>>;

/** A preset a workspace can add a provider from, as the settings list it. */
export interface PresetView {
  id: string;
  name: string;
  kind: ProviderPreset['kind'];
  capabilities: CapabilityModels;
  /** Needs a base URL of its own (an OpenAI-compatible endpoint). */
  requiresBaseUrl: boolean;
  /** Whether a workspace provider of this preset may set its own base URL (chat only). */
  customEndpoint: boolean;
  /** Assignments the first-run wizard fills for empty slots. */
  recommended: Partial<Record<SlotId, string>>;
}

/**
 * A resolved target without anything secret or internal: no credentials or
 * proxy, and an endpoint only for the workspace's own providers (a
 * deployment's endpoint may name internal hosts).
 */
export type TargetView = Omit<
  ResolvedModelTarget,
  'apiKey' | 'credentials' | 'proxy' | 'baseUrl' | 'customBaseUrl'
> & { baseUrl?: string };

export type EffectiveView =
  | ({
      status: 'assigned';
      resolvedAt: SlotId;
      source: string;
      requirements: unknown;
    } & TargetView & {
        fallback?: TargetView;
      })
  | { status: 'disabled'; resolvedAt: SlotId; source: string }
  | { status: 'unassigned' }
  | { status: 'invalid'; message: string };

export interface SlotView {
  slot: SlotId;
  parent: SlotId | null;
  capability: SlotCapability;
  configOnly: boolean;
  /** Written in the deployment layer: the workspace cannot change it. */
  locked: boolean;
  /** The workspace's own assignment, if any (undefined: follows its parent). */
  assignment?: SlotAssignment;
  effective: EffectiveView;
}

export interface ModelSettingsView {
  revision: number | null;
  policy: { allowWorkspaceProviders: boolean };
  /** The presets a workspace may add providers from (empty when the policy says no). */
  presets: PresetView[];
  providers: ProviderView[];
  slots: SlotView[];
}

export type ModelSettingsChange =
  | {
      kind: 'slots';
      /** Per slot: an assignment, or null to turn it off, or absent to follow the parent. */
      set?: Partial<Record<string, SlotAssignment>>;
      clear?: string[];
    }
  | {
      kind: 'provider';
      id: string;
      preset: string;
      /** Omitted: keep the stored key. Empty string: remove it. */
      apiKey?: string;
      baseUrl?: string | null;
      models?: string[] | null;
    }
  | { kind: 'remove-provider'; id: string };

export class ModelSettingsError extends Error {
  constructor(
    readonly code:
      | 'SLOT_LOCKED'
      | 'UNKNOWN_SLOT'
      | 'PROVIDERS_NOT_ALLOWED'
      | 'PROVIDER_RESERVED'
      | 'UNKNOWN_PROVIDER'
      | 'INVALID_PROVIDER'
      | 'INVALID_ASSIGNMENT',
    message: string,
  ) {
    super(message);
    this.name = 'ModelSettingsError';
  }
}

function hasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** An endpoint as a view shows it: never with credentials in it. */
function viewEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A key's last four characters, as far as that says nothing useful. */
function maskKey(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : '…';
}

/**
 * What a provider can be assigned to, with its models: a workspace provider
 * with its own endpoint serves chat only (see media.ts), and a preset whose
 * registry catalogue says nothing about the endpoint (an OpenAI-compatible
 * server) offers only the models the provider lists.
 */
function capabilityModels(
  preset: ProviderPreset | undefined,
  pinned?: string[],
  { chatOnly = false }: { chatOnly?: boolean } = {},
): CapabilityModels {
  const result: CapabilityModels = {};
  if (!preset) return result;
  for (const capability of Object.keys(preset.capabilities) as SlotCapability[]) {
    if (chatOnly && capability !== 'chat') continue;
    const offered = preset.trustsModelCatalogue === false ? [] : presetModels(preset, capability);
    // A provider's own model list narrows (or names) the chat models it serves.
    const models =
      capability === 'chat' && pinned?.length
        ? pinned.map((id) => ({ id, name: offered.find((model) => model.id === id)?.name ?? id }))
        : offered;
    result[capability] = { models };
  }
  return result;
}

/**
 * Why a workspace may not add a provider of this preset, or undefined when it
 * may: Bedrock falls back to the server's AWS credential chain, and a
 * self-hosted media, search or document service lives on the server's own
 * network (or needs an endpoint only the deployment may set).
 */
/** A chat preset whose default endpoint is on the server's own network (a local model server). */
function localChatDefault(preset: ProviderPreset): boolean {
  const chat = preset.capabilities.chat;
  if (!chat) return false;
  const endpoint = chat.baseUrl ?? registryDefaultBaseUrl('chat', chat.registryId);
  return endpoint !== undefined && isLocalEndpoint(endpoint);
}

/** Whether a workspace provider of this preset must name its own endpoint. */
function needsOwnEndpoint(preset: ProviderPreset): boolean {
  return preset.requiresBaseUrl === true || localChatDefault(preset);
}

function workspacePresetProblem(preset: ProviderPreset): string | undefined {
  if (preset.capabilities.chat?.registryId === 'bedrock') {
    return 'Amazon Bedrock can only be configured by the deployment (openmaic.yml)';
  }
  // The settings take one key per provider; a key pair stays in openmaic.yml.
  if (preset.requiresCredentials) {
    return `${preset.name} authenticates with a key pair, which only the deployment (openmaic.yml) can configure`;
  }
  if (preset.requiresBaseUrl && !preset.capabilities.chat) {
    return `A custom endpoint for ${preset.name} can only be configured by the deployment (openmaic.yml)`;
  }
  for (const [capability, target] of Object.entries(preset.capabilities) as [
    SlotCapability,
    NonNullable<ProviderPreset['capabilities'][SlotCapability]>,
  ][]) {
    if (capability === 'chat') continue;
    const endpoint = target.baseUrl ?? registryDefaultBaseUrl(capability, target.registryId);
    if (endpoint && isLocalEndpoint(endpoint)) {
      return `The ${preset.name} preset runs on the server's own network; only the deployment (openmaic.yml) can configure it`;
    }
  }
  return undefined;
}

function stripTarget(target: ResolvedModelTarget): TargetView {
  const {
    apiKey: _apiKey,
    credentials: _credentials,
    proxy: _proxy,
    baseUrl,
    customBaseUrl: _customBaseUrl,
    ...rest
  } = target;
  return {
    ...rest,
    ...(target.providerSource === 'workspace' && baseUrl ? { baseUrl: viewEndpoint(baseUrl) } : {}),
  };
}

function effectiveView(resolution: SlotResolution): EffectiveView {
  if (resolution.status === 'unassigned') return { status: 'unassigned' };
  if (resolution.status === 'disabled') {
    return { status: 'disabled', resolvedAt: resolution.resolvedAt, source: resolution.source };
  }
  const { fallback, requirements, resolvedAt, source } = resolution;
  return {
    status: 'assigned',
    resolvedAt,
    source,
    requirements,
    ...stripTarget(resolution),
    ...(fallback ? { fallback: stripTarget(fallback) } : {}),
  };
}

function effectiveFor(
  slot: SlotId,
  layers: {
    deployment: ModelConfigLayer | null;
    workspace: ModelConfigLayer | null;
    defaults: ModelConfigLayer | null;
  },
): EffectiveView {
  try {
    const lookup = lookupFromLayers(slot, layers);
    return effectiveView(
      lookup.configured.status === 'unassigned' ? lookup.defaults() : lookup.configured,
    );
  } catch (error) {
    if (error instanceof SlotResolutionError) return { status: 'invalid', message: error.message };
    throw error;
  }
}

export interface StoredWorkspaceConfig {
  config: ModelConfigFile;
  revision: number;
  unreadableSecrets: string[];
}

/** The view of the settings for a workspace's stored configuration (or none). */
export function modelSettingsView(stored: StoredWorkspaceConfig | null): ModelSettingsView {
  const { layer: deployment, defaults } = deploymentConfig();
  const workspace: ModelConfigLayer | null = stored
    ? { source: 'workspace', config: stored.config }
    : null;
  const deploymentProviders = deployment?.config.providers ?? {};
  const workspaceProviders = stored?.config.providers ?? {};
  const unreadable = new Set(stored?.unreadableSecrets ?? []);

  const providers: ProviderView[] = [
    ...Object.entries(deploymentProviders).map(([id, provider]) => ({
      id,
      preset: provider.preset,
      source: 'deployment' as const,
      ...(provider.models ? { models: [...provider.models] } : {}),
      capabilities: capabilityModels(getProviderPreset(provider.preset), provider.models),
    })),
    ...Object.entries(workspaceProviders).map(([id, provider]) => ({
      id,
      preset: provider.preset,
      source: 'workspace' as const,
      ...(provider.baseUrl ? { baseUrl: viewEndpoint(provider.baseUrl) } : {}),
      ...(provider.models ? { models: [...provider.models] } : {}),
      capabilities: capabilityModels(getProviderPreset(provider.preset), provider.models, {
        chatOnly: provider.baseUrl !== undefined,
      }),
      key: {
        set: Boolean(provider.apiKey) || unreadable.has(id),
        ...(provider.apiKey ? { mask: maskKey(provider.apiKey) } : {}),
        ...(unreadable.has(id) ? { unreadable: true } : {}),
      },
    })),
  ];

  const deploymentSlots = deployment?.config.slots ?? {};
  const workspaceSlots = stored?.config.slots ?? {};
  const layers = { deployment, workspace, defaults };
  const slots: SlotView[] = MODEL_SLOTS.map(({ id }) => {
    const definition = getSlot(id);
    return {
      slot: id,
      parent: (definition.parent as SlotId | null) ?? null,
      capability: definition.capability,
      configOnly: 'configOnly' in definition && definition.configOnly === true,
      locked: Object.hasOwn(deploymentSlots, id),
      ...(Object.hasOwn(workspaceSlots, id)
        ? { assignment: workspaceSlots[id as keyof typeof workspaceSlots] }
        : {}),
      effective: effectiveFor(id, layers),
    };
  });

  const allowWorkspaceProviders = deployment?.config.policy?.allowWorkspaceProviders ?? true;
  const presets: PresetView[] = allowWorkspaceProviders
    ? PROVIDER_PRESETS.filter((preset) => !workspacePresetProblem(preset)).map((preset) => ({
        id: preset.id,
        name: preset.name,
        kind: preset.kind,
        capabilities: capabilityModels(preset),
        requiresBaseUrl: needsOwnEndpoint(preset),
        customEndpoint: Boolean(preset.capabilities.chat),
        recommended: { ...(preset.recommended ?? {}) },
      }))
    : [];

  return {
    revision: stored?.revision ?? null,
    policy: { allowWorkspaceProviders },
    presets,
    providers,
    slots,
  };
}

async function checkProvider(id: string, provider: Provider): Promise<void> {
  const preset = getProviderPreset(provider.preset);
  if (!preset) throw new ModelSettingsError('INVALID_PROVIDER', 'Unknown preset');
  const problem = workspacePresetProblem(preset);
  if (problem) throw new ModelSettingsError('INVALID_PROVIDER', problem);
  // A proxy would route around the transport the checks below rely on.
  if (provider.proxy) {
    throw new ModelSettingsError(
      'INVALID_PROVIDER',
      'A proxy can only be configured by the deployment (openmaic.yml)',
    );
  }
  // Only chat goes through the pinned, redirect-refusing transport: media,
  // search and document services are reached at a preset's own endpoints
  // (lib/server/model-config/media.ts refuses anything else at run time).
  if (provider.baseUrl && !preset.capabilities.chat) {
    throw new ModelSettingsError(
      'INVALID_PROVIDER',
      `A custom endpoint for ${preset.name} can only be configured by the deployment (openmaic.yml)`,
    );
  }
  // A local model server's default endpoint is the server's own network: a
  // workspace names where its own one runs.
  if (needsOwnEndpoint(preset) && !provider.baseUrl) {
    throw new ModelSettingsError('INVALID_PROVIDER', `The ${preset.name} preset needs a base URL`);
  }
  if (provider.baseUrl) {
    // An endpoint is stored and shown in the clear: a password in it is not.
    if (hasUserinfo(provider.baseUrl)) {
      throw new ModelSettingsError(
        'INVALID_PROVIDER',
        'Put credentials in the API key, not in the base URL',
      );
    }
    const problem = await validateClientBaseUrl(provider.baseUrl);
    if (problem) throw new ModelSettingsError('INVALID_PROVIDER', problem);
  }
  void id;
}

/**
 * Apply a change to a workspace's configuration and return the configuration
 * to store. Throws ModelSettingsError for a change the workspace may not make
 * or that would not resolve.
 */
export async function applyModelSettingsChange(
  current: ModelConfigFile | null,
  change: ModelSettingsChange,
): Promise<ModelConfigFile> {
  const { layer: deployment } = deploymentConfig();
  const deploymentSlots = deployment?.config.slots ?? {};
  const deploymentProviders = deployment?.config.providers ?? {};
  const allowProviders = deployment?.config.policy?.allowWorkspaceProviders ?? true;
  const next: ModelConfigFile = {
    ...(current?.providers ? { providers: { ...current.providers } } : {}),
    ...(current?.slots ? { slots: { ...current.slots } } : {}),
  };
  const slots = (next.slots ??= {}) as Record<string, SlotAssignment>;
  const providers = (next.providers ??= {});

  if (change.kind === 'slots') {
    const touched = [...Object.keys(change.set ?? {}), ...(change.clear ?? [])];
    for (const slot of touched) {
      if (!isSlotId(slot)) throw new ModelSettingsError('UNKNOWN_SLOT', `Unknown slot ${slot}`);
      if (Object.hasOwn(deploymentSlots, slot)) {
        throw new ModelSettingsError('SLOT_LOCKED', `${slot} is set by the deployment`);
      }
    }
    for (const slot of change.clear ?? []) delete slots[slot];
    for (const [slot, assignment] of Object.entries(change.set ?? {})) {
      slots[slot] = assignment as SlotAssignment;
    }
  } else if (change.kind === 'provider') {
    if (!allowProviders) {
      throw new ModelSettingsError(
        'PROVIDERS_NOT_ALLOWED',
        'This deployment does not let workspaces add providers',
      );
    }
    if (Object.hasOwn(deploymentProviders, change.id)) {
      throw new ModelSettingsError('PROVIDER_RESERVED', 'The deployment declares this provider id');
    }
    const existing = Object.hasOwn(providers, change.id) ? providers[change.id] : undefined;
    const apiKey =
      change.apiKey === undefined
        ? existing?.apiKey
        : change.apiKey === ''
          ? undefined
          : change.apiKey;
    const baseUrl =
      change.baseUrl === undefined ? existing?.baseUrl : (change.baseUrl ?? undefined);
    const models = change.models === undefined ? existing?.models : (change.models ?? undefined);
    const provider: Provider = {
      preset: change.preset,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(models?.length ? { models } : {}),
    };
    await checkProvider(change.id, provider);
    providers[change.id] = provider;
  } else {
    if (!Object.hasOwn(providers, change.id)) {
      throw new ModelSettingsError('UNKNOWN_PROVIDER', 'No such workspace provider');
    }
    delete providers[change.id];
    // Assignments that named it lose it and follow their parents again.
    for (const [slot, assignment] of Object.entries(slots)) {
      if (assignment === null) continue;
      const refs =
        typeof assignment === 'string' ? [assignment] : [assignment.model, assignment.fallback];
      if (refs.some((ref) => ref?.split(':')[0] === change.id)) delete slots[slot];
    }
  }

  if (!Object.keys(slots).length) delete next.slots;
  if (!Object.keys(providers).length) delete next.providers;

  // The stored shape (provider ids, fields, references), as persistence checks it.
  const shape = checkModelConfigShape(next);
  if (!shape.config) {
    throw new ModelSettingsError(
      change.kind === 'slots' ? 'INVALID_ASSIGNMENT' : 'INVALID_PROVIDER',
      shape.issues.join('; '),
    );
  }

  // Every slot the workspace writes must resolve against the whole
  // configuration: providers declared, capabilities offered.
  const layers: ModelConfigLayer[] = [
    ...(deployment ? [deployment] : []),
    { source: 'workspace', config: next },
  ];
  for (const slot of Object.keys(next.slots ?? {})) {
    try {
      const resolution = resolveSlot(slot as SlotId, layers);
      if (resolution.status === 'assigned' && getSlot(slot as SlotId).capability !== 'chat') {
        for (const target of [resolution, resolution.fallback]) {
          if (target?.providerSource === 'workspace' && target.customBaseUrl) {
            throw new ModelSettingsError(
              'INVALID_ASSIGNMENT',
              `${slot} cannot use ${target.providerId}: a workspace provider with its own endpoint serves chat slots only`,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof SlotResolutionError) {
        throw new ModelSettingsError('INVALID_ASSIGNMENT', error.message);
      }
      throw error;
    }
  }
  return next;
}

/**
 * The workspace providers whose stored key a change removes on purpose (an
 * empty key), so that a key the instance can no longer open is deleted too
 * rather than carried over.
 */
export function keysClearedBy(change: ModelSettingsChange): string[] {
  return change.kind === 'provider' && change.apiKey === '' ? [change.id] : [];
}

/** Providers and slot assignments proposed from elsewhere (settings a browser kept). */
export interface ModelSettingsProposal {
  /** Each checked on its own (see {@link importedProviderSchema}). */
  providers?: Record<string, unknown>;
  slots?: Record<string, SlotAssignment>;
}

export interface ModelSettingsImport {
  config: ModelConfigFile;
  /** What was taken: provider ids and slot ids. */
  imported: string[];
  /** What was left out, and why. Never an existing setting: those always win. */
  skipped: { item: string; reason: string }[];
}

/** One proposed provider: what an edit may set. */
const importedProviderSchema = z
  .object({
    preset: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/**
 * Merge a proposal into a workspace's configuration, one item at a time and
 * under the same checks as an edit. Nothing already there is replaced: a
 * provider id the workspace or the deployment already declares, a slot the
 * workspace already set or the deployment locks, are left as they are. Items
 * that fail a check are skipped with the reason; the rest are kept.
 */
export async function importModelSettings(
  current: ModelConfigFile | null,
  proposal: ModelSettingsProposal,
): Promise<ModelSettingsImport> {
  const { layer: deployment } = deploymentConfig();
  let config: ModelConfigFile = current ?? {};
  const imported: string[] = [];
  const skipped: ModelSettingsImport['skipped'] = [];
  const attempt = async (item: string, change: ModelSettingsChange) => {
    try {
      config = await applyModelSettingsChange(config, change);
      imported.push(item);
    } catch (error) {
      if (!(error instanceof ModelSettingsError)) throw error;
      skipped.push({ item, reason: error.message });
    }
  };

  for (const [id, provider] of Object.entries(proposal.providers ?? {})) {
    if (
      Object.hasOwn(config.providers ?? {}, id) ||
      Object.hasOwn(deployment?.config.providers ?? {}, id)
    ) {
      skipped.push({ item: id, reason: 'A provider with this id already exists' });
      continue;
    }
    const parsed = importedProviderSchema.safeParse(provider);
    if (!parsed.success) {
      skipped.push({ item: id, reason: 'Malformed provider settings' });
      continue;
    }
    await attempt(id, { kind: 'provider', id, ...parsed.data });
  }
  for (const [slot, assignment] of Object.entries(proposal.slots ?? {})) {
    if (Object.hasOwn(config.slots ?? {}, slot)) {
      skipped.push({ item: slot, reason: 'The workspace already sets this slot' });
      continue;
    }
    await attempt(slot, { kind: 'slots', set: { [slot]: assignment } });
  }
  return { config, imported, skipped };
}
