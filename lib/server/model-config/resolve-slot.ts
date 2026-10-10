/**
 * Slot resolution (RFC #1701, tracked in #1725).
 *
 * `resolveSlot` walks from a slot up to its capability root and returns the
 * first assignment it meets; an explicit `null` stops the walk and disables
 * the subtree, and reaching the root without an assignment leaves the
 * capability unassigned. There is no fallback to any vendor.
 *
 * Two layers take part. The deployment layer (openmaic.yml, or what the legacy
 * variables translate to) holds the server's defaults and names what is
 * locked; the workspace layer holds the web settings.
 * - A slot in a locked subtree (the slot or an ancestor is named by `lock`, or
 *   `lock: all`) resolves from the deployment alone, walking up to the locked
 *   node: nothing a workspace sets there counts.
 * - Any other slot walks the workspace's assignments from the slot up to
 *   the root first, and only when it finds none, the deployment's defaults
 *   the same way: the user's choice anywhere up the tree beats a server
 *   default, even one written nearer the slot. `null` stops either walk.
 *
 * This is pure: it takes the layers as input and builds no SDK clients.
 */
import { officialRegionalEndpoint } from '@/lib/config/official-endpoints';
import { PROVIDERS } from '@/lib/ai/providers';
import { findModelById } from '@/lib/ai/model-aliases';
import { withoutThinkingEffort } from '@/lib/ai/thinking-config';
import {
  getSlot,
  slotLineage,
  slotRefusesThinkingEffort,
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

/** Where a layer comes from: the deployment (openmaic.yml) or the web settings. */
export type ConfigSource = 'deployment' | 'workspace';

/**
 * Where a slot's value comes from: the deployment's default, the workspace's
 * own assignment, or the deployment inside a locked subtree.
 */
export type SlotSource = 'default' | 'workspace' | 'locked';

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
  /** Where the assignment came from. */
  source: SlotSource;
  /** Whether the slot is in a locked subtree, so the web UI cannot change it. */
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
  /** `locked`: in a locked subtree (`lock: all` over a root the deployment leaves unset). */
  | { status: 'unassigned'; slot: SlotId; locked?: true };

export class SlotResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotResolutionError';
  }
}

function assignmentIn(
  layer: ModelConfigLayer | undefined,
  node: SlotId,
): { assignment: SlotAssignment } | undefined {
  const slots = layer?.config.slots;
  return slots && Object.hasOwn(slots, node) ? { assignment: slots[node] } : undefined;
}

/**
 * The node whose lock covers a slot: the slot itself or the nearest ancestor
 * `lock` names (with `lock: all`, the capability root), else undefined.
 */
export function lockingNode(config: ModelConfigFile | undefined, slot: SlotId): SlotId | undefined {
  const lock = config?.lock;
  if (!lock) return undefined;
  const lineage = slotLineage(slot);
  if (lock === 'all') return lineage[lineage.length - 1];
  return lineage.find((node) => lock.includes(node));
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

/**
 * What a model reference (`providerId:modelId`, or the provider alone)
 * resolves to for a capability over the layers, outside any slot: the target
 * the settings test when they check a provider. Throws SlotResolutionError
 * when the provider is not declared or does not offer the capability.
 */
export function resolveModelReference(
  ref: string,
  capability: SlotCapability,
  layers: readonly ModelConfigLayer[],
  { providerOnly = false }: { providerOnly?: boolean } = {},
): ResolvedModelTarget {
  return resolveTarget(ref, capability, inPrecedence(layers), 'reference', providerOnly);
}

function resolveTarget(
  ref: string,
  capability: SlotCapability,
  layers: readonly ModelConfigLayer[],
  at: string,
  /** The provider's connection alone: a chat reference without a model is accepted. */
  providerOnly = false,
): ResolvedModelTarget {
  let parsed: { providerId: string; modelId?: string };
  try {
    parsed = parseModelRef(ref);
  } catch {
    throw new SlotResolutionError(`${at}: invalid model reference`);
  }
  const { providerId, modelId } = parsed;
  if (modelId === undefined && capability === 'chat' && !providerOnly) {
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
  // A service whose official endpoint is per region (Azure Speech) names its
  // region with an endpoint of its own: one on the official host is the
  // vendor's, not a custom one, and is used in its normalised form. Anything
  // else stays custom (which only the deployment may configure for media).
  const official =
    provider.baseUrl !== undefined
      ? officialRegionalEndpoint(capability, target.registryId, provider.baseUrl)
      : undefined;
  return {
    providerId,
    providerSource: found.source,
    presetId: preset.id,
    registryId: target.registryId,
    baseUrl: official ?? provider.baseUrl ?? target.baseUrl,
    ...(provider.baseUrl !== undefined && !official ? { customBaseUrl: true as const } : {}),
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

const SOURCE_RANK: Record<ConfigSource, number> = { deployment: 0, workspace: 1 };

/** The deployment before the workspace, whatever order the caller passed them in. */
function inPrecedence(layers: readonly ModelConfigLayer[]): ModelConfigLayer[] {
  return [...layers].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
}

/**
 * The assignment a slot resolves through: the node that holds it, where it
 * comes from, and the value; undefined when nothing up to the root (or the
 * locked node) assigns it. No provider is looked up.
 */
export function findAssignment(
  slot: SlotId,
  deployment: ModelConfigLayer | undefined,
  workspace: ModelConfigLayer | undefined,
): { node: SlotId; source: SlotSource; assignment: SlotAssignment } | undefined {
  const lineage = slotLineage(slot);
  const lockedAt = lockingNode(deployment?.config, slot);
  if (lockedAt !== undefined) {
    // Inside a locked subtree only the deployment counts, up to the locked node.
    for (const node of lineage.slice(0, lineage.indexOf(lockedAt) + 1)) {
      const found = assignmentIn(deployment, node);
      if (found) return { node, source: 'locked', ...found };
    }
    return undefined;
  }
  // The user's choice anywhere up the tree beats the server's defaults: only
  // when the workspace assigns nothing from the slot to the root do the
  // defaults count.
  for (const node of lineage) {
    const own = assignmentIn(workspace, node);
    if (own) return { node, source: 'workspace', ...own };
  }
  for (const node of lineage) {
    const fallback = assignmentIn(deployment, node);
    if (fallback) return { node, source: 'default', ...fallback };
  }
  return undefined;
}

export function resolveSlot(
  slot: SlotId,
  givenLayers: readonly ModelConfigLayer[],
): SlotResolution {
  const layers = inPrecedence(givenLayers);
  const deployment = layers.find((layer) => layer.source === 'deployment');
  const workspace = layers.find((layer) => layer.source === 'workspace');
  const capability = getSlot(slot).capability;
  const found = findAssignment(slot, deployment, workspace);
  if (found) {
    const { node, assignment } = found;
    const base: ResolvedNode = {
      slot,
      resolvedAt: node,
      source: found.source,
      locked: lockingNode(deployment?.config, slot) !== undefined,
    };
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
    // A slot that may not carry a thinking effort drops one it inherits; one
    // set on the slot itself is refused when the configuration is saved.
    const own = 'thinking' in spec ? (spec.thinking as ThinkingConfig | undefined) : undefined;
    const thinking =
      node !== slot && slotRefusesThinkingEffort(slot) ? withoutThinkingEffort(own) : own;
    return {
      ...base,
      ...target,
      status: 'assigned',
      capability,
      ...(thinking ? { thinking } : {}),
      ...('api' in spec && spec.api ? { api: spec.api } : {}),
      ...('contextWindow' in spec && spec.contextWindow
        ? { contextWindow: spec.contextWindow }
        : {}),
      ...(fallback ? { fallback } : {}),
      requirements,
      ...(fallbackRequirements ? { fallbackRequirements } : {}),
    };
  }
  return {
    status: 'unassigned',
    slot,
    ...(lockingNode(deployment?.config, slot) !== undefined ? { locked: true as const } : {}),
  };
}
