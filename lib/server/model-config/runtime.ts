/**
 * Slot resolution at request time (RFC #1701, tracked in #1725).
 *
 * The configured answer comes from the deployment layer (openmaic.yml, loaded
 * once per process) and the workspace layer (the request owner's web
 * settings), walked together over the whole slot tree: a workspace model on
 * `llm` covers every chat slot below it. Only when that leaves a slot
 * unassigned does a caller look further, first at what a request still names
 * the old way (model and key headers, deprecated) and then at the defaults an
 * older deployment set through DEFAULT_MODEL and friends. The defaults are a
 * second walk rather than a third layer in the first one, so that a default
 * never outranks a workspace choice made higher up the tree.
 */
import { slotForStage, type SlotCapability, type SlotId } from '@/lib/config/model-slots';
import { createLogger } from '@/lib/logger';
import type { LlmStage } from '@/lib/server/model-routes';
import type { OwnerAuthRequest } from '@/lib/server/identity/types';

import { loadDeploymentLayer, type DeploymentLayer } from './deployment-layer';
import { parseModelRef, type ModelConfigFile, type SlotAssignment } from './openmaic-yml';
import {
  resolveModelReference,
  resolveSlot,
  SlotResolutionError,
  type ModelConfigLayer,
  type ResolvedModelTarget,
  type SlotResolution,
} from './resolve-slot';

const log = createLogger('ModelConfig');

const STATE_KEY = Symbol.for('openmaic.model-config.deployment');
const globalState = globalThis as typeof globalThis & { [STATE_KEY]?: DeploymentLayer };

/**
 * The deployment layer and legacy defaults, loaded on first use and kept for
 * the life of the process (openmaic.yml applies on restart). Startup calls
 * this so that a broken file or a leftover MODEL_ROUTES stops the server
 * before it serves anything, and prints the notices once.
 */
export function deploymentConfig(): DeploymentLayer {
  const cached = globalState[STATE_KEY];
  if (cached) return cached;
  const loaded = loadDeploymentLayer();
  for (const notice of loaded.notices) log.warn(notice);
  globalState[STATE_KEY] = loaded;
  return loaded;
}

/** Replace (or, with undefined, forget) the loaded deployment configuration. */
export function setDeploymentConfigForTests(config?: DeploymentLayer): void {
  if (config) globalState[STATE_KEY] = config;
  else delete globalState[STATE_KEY];
}

type WorkspaceLayerLoader = (ownerId: string) => Promise<ModelConfigLayer | null>;
let loadWorkspace: WorkspaceLayerLoader | undefined;

/** Replace how workspace settings are read; undefined restores the database. */
export function setWorkspaceLayerLoaderForTests(loader?: WorkspaceLayerLoader): void {
  loadWorkspace = loader;
}

/**
 * The web settings of exactly `ownerId` as a layer, or null when there are
 * none. Never forwarded through a claim: a request's owner claimed between its
 * check and this read finds nothing rather than the account's settings.
 * Background work that may outlive a claim passes the owner it works for now
 * (canonicalizeStoredOwner) instead.
 */
export async function workspaceLayer(ownerId: string): Promise<ModelConfigLayer | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  const [{ getServerPersistenceProvider }, { readWorkspaceModelConfig }] = await Promise.all([
    import('@/lib/persistence/server-provider'),
    import('@/lib/persistence/workspace-model-config'),
  ]);
  const { pool } = await getServerPersistenceProvider(databaseUrl);
  const stored = await readWorkspaceModelConfig(pool, ownerId);
  if (!stored) return null;
  if (stored.unreadableSecrets.length) {
    log.warn(
      `Workspace keys for ${stored.unreadableSecrets.length} provider(s) cannot be read with the current instance secret; they have to be entered again`,
    );
  }
  return { source: 'workspace', config: stored.config };
}

/**
 * The workspace a request belongs to: its owner. A refused credential throws
 * (InvalidOwnerCredentialError, 401) rather than falling through to the
 * deployment's models. An owner minted for this request has no settings yet,
 * and a retired owner's settings moved to the account that claimed it: the
 * request gets no workspace, never the account's.
 */
export async function requestWorkspaceId(req: OwnerAuthRequest): Promise<string | null> {
  const { resolveRequestOwner, InvalidOwnerCredentialError } =
    await import('@/lib/server/identity/resolve');
  const outcome = await resolveRequestOwner(req);
  if (!outcome.ok) throw new InvalidOwnerCredentialError();
  if (outcome.principal.assurance === 'minted') return null;
  const ownerId = outcome.principal.ownerId;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  const [{ getServerPersistenceProvider }, { isOwnerRetired }] = await Promise.all([
    import('@/lib/persistence/server-provider'),
    import('@/lib/persistence/owner-merges'),
  ]);
  const { pool } = await getServerPersistenceProvider(databaseUrl);
  return (await isOwnerRetired(pool, ownerId)) ? null : ownerId;
}

/**
 * The workspace for background work on behalf of a stored owner (an agent
 * run, a generation job): the owner it belongs to now, forwarded through a
 * claim that happened since the work started. Only for owners taken from
 * durable records; a request's owner goes through {@link requestWorkspaceId}.
 */
export async function backgroundWorkspaceId(storedOwnerId: string): Promise<string> {
  if (!process.env.DATABASE_URL?.trim()) return storedOwnerId;
  const { canonicalizeStoredOwner } = await import('@/lib/persistence/owner-merges');
  return canonicalizeStoredOwner(storedOwnerId);
}

export interface SlotLookup {
  /** Through the deployment and the workspace. */
  configured: SlotResolution;
  /** Through the legacy defaults, for when `configured` is unassigned. */
  defaults(): SlotResolution;
}

export interface ResolutionLayers {
  deployment: ModelConfigLayer | null;
  workspace: ModelConfigLayer | null;
  defaults: ModelConfigLayer | null;
}

/**
 * The providers only the workspace declares: a reference to an id the
 * deployment also declares resolves to the deployment's provider.
 */
export function workspaceOnlyProviders(
  workspace: ModelConfigLayer,
  deployment: ModelConfigLayer | null,
): Set<string> {
  const declared = deployment?.config.providers ?? {};
  return new Set(
    Object.keys(workspace.config.providers ?? {}).filter((id) => !Object.hasOwn(declared, id)),
  );
}

/**
 * The workspace layer as the deployment's policy lets it count. With
 * `policy.allowWorkspaceProviders: false`, providers a workspace added earlier
 * are not used: they are left out, with the assignments that name them (an
 * assignment whose fallback alone names one keeps its model).
 */
export function workspaceUnderPolicy(
  workspace: ModelConfigLayer | null,
  deployment: ModelConfigLayer | null,
): ModelConfigLayer | null {
  if (!workspace || deployment?.config.policy?.allowWorkspaceProviders !== false) return workspace;
  const own = workspaceOnlyProviders(workspace, deployment);
  if (!own.size && !workspace.config.providers) return workspace;
  const names = (ref: string | undefined) => {
    if (!ref) return false;
    try {
      return own.has(parseModelRef(ref).providerId);
    } catch {
      return false;
    }
  };
  const slots: Record<string, SlotAssignment> = {};
  for (const [slot, assignment] of Object.entries(workspace.config.slots ?? {})) {
    if (assignment === null || assignment === undefined) {
      if (assignment === null) slots[slot] = null;
      continue;
    }
    if (typeof assignment === 'string') {
      if (!names(assignment)) slots[slot] = assignment;
      continue;
    }
    if (names(assignment.model)) continue;
    if (names(assignment.fallback)) {
      const { fallback: _fallback, ...kept } = assignment;
      slots[slot] = kept as SlotAssignment;
    } else {
      slots[slot] = assignment;
    }
  }
  const { providers: _providers, ...rest } = workspace.config;
  return { ...workspace, config: { ...rest, slots } as ModelConfigFile };
}

/** The lookup over given layers; {@link lookupSlot} gathers them for a workspace. */
export function lookupFromLayers(
  slot: SlotId,
  { deployment, workspace: stored, defaults }: ResolutionLayers,
): SlotLookup {
  const workspace = workspaceUnderPolicy(stored, deployment);
  const persisted = [deployment, workspace].filter((entry): entry is ModelConfigLayer => !!entry);
  return {
    configured: resolveSlot(slot, persisted),
    defaults: () =>
      defaults
        ? resolveSlot(slot, [...(deployment ? [deployment] : []), defaults])
        : { status: 'unassigned', slot },
  };
}

export async function lookupSlot(slot: SlotId, workspaceId: string | null): Promise<SlotLookup> {
  const { layer, defaults } = deploymentConfig();
  const workspace = workspaceId ? await (loadWorkspace ?? workspaceLayer)(workspaceId) : null;
  return lookupFromLayers(slot, { deployment: layer, workspace, defaults });
}

/** {@link lookupSlot} for a call site that knows its stage key. */
export function lookupStage(stage: LlmStage, workspaceId: string | null): Promise<SlotLookup> {
  return lookupSlot(slotForStage(stage), workspaceId);
}

export class SlotDisabledError extends Error {
  constructor(readonly slot: SlotId) {
    super(`The ${slot} capability is turned off in the model configuration`);
    this.name = 'SlotDisabledError';
  }
}

export class SlotUnassignedError extends Error {
  constructor(readonly slot: SlotId) {
    super(
      `No model is configured for ${slot}. Set one in the model settings, or assign the slot (or an ancestor) in openmaic.yml.`,
    );
    this.name = 'SlotUnassignedError';
  }
}

/**
 * A provider the workspace has configured (the deployment's, or its own as
 * the policy lets it count), resolved by reference for a capability: what the
 * settings' test buttons check, so that the browser names a saved provider
 * and never sends its key. With `workspaceOnly`, only the workspace's own
 * providers (what the settings may edit, such as fetching a model list).
 * Throws SlotResolutionError when there is no such provider.
 */
export async function savedProviderTarget(
  ref: string,
  capability: SlotCapability,
  workspaceId: string | null,
  { workspaceOnly = false }: { workspaceOnly?: boolean } = {},
): Promise<ResolvedModelTarget> {
  const { layer: deployment } = deploymentConfig();
  const stored = workspaceId ? await (loadWorkspace ?? workspaceLayer)(workspaceId) : null;
  const workspace = workspaceUnderPolicy(stored, deployment);
  const layers = workspaceOnly
    ? [workspace].filter((entry): entry is ModelConfigLayer => !!entry)
    : [deployment, workspace].filter((entry): entry is ModelConfigLayer => !!entry);
  const target = resolveModelReference(ref, capability, layers);
  // A deployment's provider of the same id outranks the workspace's.
  if (
    workspaceOnly &&
    deployment?.config.providers &&
    Object.hasOwn(deployment.config.providers, target.providerId)
  ) {
    throw new SlotResolutionError("reference: the provider is the deployment's");
  }
  return target;
}
