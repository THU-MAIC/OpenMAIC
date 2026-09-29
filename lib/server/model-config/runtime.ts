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
import { slotForStage, type SlotId } from '@/lib/config/model-slots';
import { createLogger } from '@/lib/logger';
import type { LlmStage } from '@/lib/server/model-routes';
import type { OwnerAuthRequest } from '@/lib/server/identity/types';

import { loadDeploymentLayer, type DeploymentLayer } from './deployment-layer';
import { resolveSlot, type ModelConfigLayer, type SlotResolution } from './resolve-slot';

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

/** The lookup over given layers; {@link lookupSlot} gathers them for a workspace. */
export function lookupFromLayers(
  slot: SlotId,
  { deployment, workspace, defaults }: ResolutionLayers,
): SlotLookup {
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
