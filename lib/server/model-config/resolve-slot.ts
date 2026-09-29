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

export type ConfigSource = 'deployment' | 'workspace';

export interface ModelConfigLayer {
  source: ConfigSource;
  config: ModelConfigFile;
}

/** Where a model comes from: one declared provider and one of its models. */
export interface ResolvedModelTarget {
  providerId: string;
  /** False when the registry's model catalogue does not describe this endpoint. */
  catalogue?: false;
  presetId: string;
  registryId: string;
  /** The provider's own base URL, else the preset's (token plans); undefined means the registry default. */
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
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
    if (providers && Object.hasOwn(providers, providerId)) return providers[providerId];
  }
  return undefined;
}

function resolveTarget(
  ref: string,
  capability: SlotCapability,
  layers: readonly ModelConfigLayer[],
  at: string,
): ResolvedModelTarget {
  let parsed: { providerId: string; modelId: string };
  try {
    parsed = parseModelRef(ref);
  } catch {
    throw new SlotResolutionError(`${at}: invalid model reference`);
  }
  const { providerId, modelId } = parsed;
  const provider = findProvider(providerId, layers);
  if (!provider) throw new SlotResolutionError(`${at}: provider "${providerId}" is not declared`);
  const preset = getProviderPreset(provider.preset);
  if (!preset) {
    throw new SlotResolutionError(`${at}: provider "${providerId}" has an unknown preset`);
  }
  const target = preset.capabilities[capability];
  if (!target) {
    throw new SlotResolutionError(
      `${at}: provider "${providerId}" (preset "${preset.id}") does not offer ${capability}`,
    );
  }
  return {
    providerId,
    presetId: preset.id,
    registryId: target.registryId,
    baseUrl: provider.baseUrl ?? target.baseUrl,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    modelId,
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

export function resolveSlot(slot: SlotId, layers: readonly ModelConfigLayer[]): SlotResolution {
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
