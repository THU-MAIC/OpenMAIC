/**
 * Slot resolution (RFC #1701, tracked in #1725).
 *
 * `resolveSlot` walks from a slot up to its capability root and returns the
 * first assignment it meets. At each node the layers are consulted in order:
 * the deployment layer (openmaic.yml, which locks what it sets) before the
 * workspace layer (the web UI). An explicit `null` stops the walk and disables
 * the subtree; reaching the root without an assignment leaves the capability
 * unassigned. There is no fallback to any vendor.
 *
 * This is pure: it takes the layers as input and builds no SDK clients.
 * Nothing calls it yet.
 */
import { PROVIDERS } from '@/lib/ai/providers';
import { findModelById } from '@/lib/ai/model-aliases';
import {
  getSlot,
  slotLineage,
  type SlotCapability,
  type SlotId,
  type SlotRequirement,
} from '@/lib/config/model-slots';
import { getProviderPreset } from '@/lib/config/provider-presets';
import type { ThinkingConfig } from '@/lib/types/provider';
import {
  parseModelRef,
  type ModelConfigFile,
  type SlotAssignment,
} from '@/lib/server/model-config/openmaic-yml';

/**
 * `deployment`: openmaic.yml, which locks what it sets. `workspace`: the web
 * settings. `default`: what an older deployment configured through
 * DEFAULT_MODEL and friends; it locks nothing and ranks below both.
 */
export type ConfigSource = 'deployment' | 'workspace' | 'default';

export interface ModelConfigLayer {
  source: ConfigSource;
  config: ModelConfigFile;
}

/** Where a model comes from: one declared provider and one of its models. */
export interface ResolvedModelTarget {
  providerId: string;
  /**
   * The layer that declares the provider. A workspace provider's endpoint was
   * typed by a user, so callers treat it as untrusted.
   */
  providerSource: ConfigSource;
  /** False when the registry's model catalogue does not describe this endpoint. */
  catalogue?: false;
  presetId: string;
  registryId: string;
  /** The provider's own base URL, else the preset's (token plans); undefined means the registry default. */
  baseUrl?: string;
  apiKey?: string;
  /** Multi-part credentials for vendors without a single key. */
  credentials?: Record<string, string>;
  proxy?: string;
  /** The provider's non-secret, provider-specific settings (openmaic.yml `options`). */
  options?: Record<string, string | number | boolean>;
  /** The base URL is the provider's own, not the preset's or registry's. */
  customBaseUrl?: true;
  /** Absent: the provider's default model (never for chat). */
  modelId?: string;
}

export interface RequirementCheck {
  requirement: SlotRequirement;
  /** `unknown` when the model catalogue does not say. */
  status: 'met' | 'unmet' | 'unknown';
}

interface ResolvedNode {
  slot: SlotId;
  /** The node that held the assignment: the slot itself or an ancestor. */
  resolvedAt: SlotId;
  /** The layer that held the assignment. */
  source: ConfigSource;
  /**
   * Whether the requested slot itself is written in the deployment layer, so
   * the web UI cannot change it. Inheriting a deployment value does not lock a
   * slot: the workspace may still assign it.
   */
  locked: boolean;
}

export type SlotResolution =
  | (ResolvedNode &
      ResolvedModelTarget & {
        status: 'assigned';
        capability: SlotCapability;
        thinking?: ThinkingConfig;
        api?: string;
        contextWindow?: number;
        fallback?: ResolvedModelTarget;
        requirements: RequirementCheck[];
        /** The same requirements checked against the fallback model. */
        fallbackRequirements?: RequirementCheck[];
      })
  | (ResolvedNode & { status: 'disabled' })
  | { status: 'unassigned'; slot: SlotId };

export class SlotResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotResolutionError';
  }
}

function findAssignment(
  node: SlotId,
  layers: readonly ModelConfigLayer[],
): { assignment: SlotAssignment; layer: ModelConfigLayer } | undefined {
  for (const layer of layers) {
    const slots = layer.config.slots;
    if (slots && Object.hasOwn(slots, node)) return { assignment: slots[node], layer };
  }
  return undefined;
}

/**
 * The provider a reference names, looked up in the layers in order, so a
 * workspace cannot shadow a provider the deployment declares.
 */
function findProvider(providerId: string, layers: readonly ModelConfigLayer[]) {
  for (const layer of layers) {
    const providers = layer.config.providers;
    if (providers && Object.hasOwn(providers, providerId)) {
      return { provider: providers[providerId], source: layer.source };
    }
  }
  return undefined;
}

function resolveTarget(
  ref: string,
  capability: SlotCapability,
  layers: readonly ModelConfigLayer[],
  at: string,
): ResolvedModelTarget {
  let parsed: { providerId: string; modelId?: string };
  try {
    parsed = parseModelRef(ref);
  } catch {
    throw new SlotResolutionError(`${at}: invalid model reference`);
  }
  const { providerId, modelId } = parsed;
  if (modelId === undefined && capability === 'chat') {
    throw new SlotResolutionError(`${at}: a chat model needs "providerId:modelId"`);
  }
  const found = findProvider(providerId, layers);
  // Errors name the path, never a value taken from the reference: a key pasted
  // into the provider position must not end up in a log.
  if (!found) throw new SlotResolutionError(`${at}: the provider is not declared`);
  const { provider } = found;
  const preset = getProviderPreset(provider.preset);
  if (!preset) throw new SlotResolutionError(`${at}: the provider has an unknown preset`);
  const target = preset.capabilities[capability];
  if (!target) {
    throw new SlotResolutionError(
      `${at}: the provider (preset "${preset.id}") does not offer ${capability}`,
    );
  }
  return {
    providerId,
    providerSource: found.source,
    presetId: preset.id,
    registryId: target.registryId,
    baseUrl: provider.baseUrl ?? target.baseUrl,
    ...(provider.baseUrl !== undefined ? { customBaseUrl: true as const } : {}),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    ...(provider.credentials !== undefined ? { credentials: provider.credentials } : {}),
    ...(provider.proxy !== undefined ? { proxy: provider.proxy } : {}),
    ...(provider.options !== undefined ? { options: { ...provider.options } } : {}),
    // A provider-only reference means the preset's own default (a token
    // plan's), else the registry's, which the adapter applies.
    ...((modelId ?? target.defaultModel) !== undefined
      ? { modelId: modelId ?? target.defaultModel }
      : {}),
    ...(preset.trustsModelCatalogue === false ? { catalogue: false as const } : {}),
  };
}

/** Requirement status from the built-in chat model catalogue. */
function checkRequirement(
  requirement: SlotRequirement,
  capability: SlotCapability,
  target: ResolvedModelTarget,
): RequirementCheck {
  if (requirement !== 'toolCalling' || capability !== 'chat' || target.catalogue === false) {
    return { requirement, status: 'unknown' };
  }
  if (target.modelId === undefined) return { requirement, status: 'unknown' };
  const registry = (PROVIDERS as Record<string, { models?: readonly ModelLike[] }>)[
    target.registryId
  ];
  const model = findModelById(target.registryId, registry?.models, target.modelId);
  const tools = model?.capabilities?.tools;
  return { requirement, status: tools === true ? 'met' : tools === false ? 'unmet' : 'unknown' };
}

type ModelLike = { id: string; capabilities?: { tools?: boolean } };

function isLockedByDeployment(slot: SlotId, layers: readonly ModelConfigLayer[]): boolean {
  return layers.some(
    (layer) =>
      layer.source === 'deployment' &&
      !!layer.config.slots &&
      Object.hasOwn(layer.config.slots, slot),
  );
}

const SOURCE_RANK: Record<ConfigSource, number> = { deployment: 0, workspace: 1, default: 2 };

/** Deployment, then workspace, then default layers, whatever order the caller passed them in. */
function inPrecedence(layers: readonly ModelConfigLayer[]): ModelConfigLayer[] {
  return [...layers].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
}

export function resolveSlot(
  slot: SlotId,
  givenLayers: readonly ModelConfigLayer[],
): SlotResolution {
  const layers = inPrecedence(givenLayers);
  const capability = getSlot(slot).capability;
  for (const node of slotLineage(slot)) {
    const found = findAssignment(node, layers);
    if (!found) continue;
    const base: ResolvedNode = {
      slot,
      resolvedAt: node,
      source: found.layer.source,
      locked: isLockedByDeployment(slot, layers),
    };
    const { assignment } = found;
    if (assignment === null) return { ...base, status: 'disabled' };

    const at = `slots.${node}`;
    const spec = typeof assignment === 'string' ? { model: assignment } : assignment;
    const target = resolveTarget(spec.model, capability, layers, at);
    // Only language-model calls retry on a fallback; a fallback anywhere else
    // would be configuration that silently does nothing.
    if (spec.fallback && capability !== 'chat') {
      throw new SlotResolutionError(`${at}.fallback: only language model slots use a fallback`);
    }
    const fallback = spec.fallback
      ? resolveTarget(spec.fallback, capability, layers, `${at}.fallback`)
      : undefined;
    // Requirements are the requested slot's own, checked against the model it
    // resolves to, whether assigned here or inherited.
    const requires = getSlot(slot).requires ?? [];
    const requirements = requires.map((requirement) =>
      checkRequirement(requirement, capability, target),
    );
    const fallbackRequirements =
      fallback && requires.length
        ? requires.map((requirement) => checkRequirement(requirement, capability, fallback))
        : undefined;
    return {
      ...base,
      ...target,
      status: 'assigned',
      capability,
      ...('thinking' in spec && spec.thinking ? { thinking: spec.thinking as ThinkingConfig } : {}),
      ...('api' in spec && spec.api ? { api: spec.api } : {}),
      ...('contextWindow' in spec && spec.contextWindow
        ? { contextWindow: spec.contextWindow }
        : {}),
      ...(fallback ? { fallback } : {}),
      requirements,
      ...(fallbackRequirements ? { fallbackRequirements } : {}),
    };
  }
  return { status: 'unassigned', slot };
}
