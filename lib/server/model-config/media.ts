/**
 * Media and tool capabilities from slot resolutions (RFC #1701, tracked in
 * #1725): text to speech, speech recognition, images, video, web search and
 * document extraction.
 *
 * The order matches language models: the configured slot (deployment, then
 * workspace); else the provider the request names the old way (deprecated);
 * else the defaults an older deployment set by configuring providers; else a
 * loud error. A slot turned off fails whatever the request names.
 *
 * A connection is `managed` when its endpoint is operator configuration
 * (deployment or legacy providers), which media routes already trust. A
 * workspace provider's endpoint was typed by a user: it is validated like a
 * caller-supplied base URL, and a workspace may not set a proxy.
 */
import { getSlot, type SlotId } from '@/lib/config/model-slots';
import { registryDefaultBaseUrl } from '@/lib/config/provider-presets';
import { apiError } from '@/lib/server/api-response';
import { InvalidOwnerCredentialError } from '@/lib/server/identity/resolve';
import { invalidOwnerCredentialResponse } from '@/lib/server/identity/with-owner';

import { isServerProviderDisabled } from '@/lib/server/provider-config';
import { isIP } from 'node:net';
import { isPrivateIP } from '@/lib/server/ssrf-guard';

import type { ResolvedModelTarget, SlotResolution } from './resolve-slot';
import {
  backgroundWorkspaceId,
  lookupSlot,
  SlotDisabledError,
  SlotUnassignedError,
} from './runtime';

export { adapterOptions } from './adapter-options';

/** The server-providers section whose force-off switch covers a slot. */
const FORCE_OFF_SECTION = {
  tts: 'tts',
  asr: 'asr',
  image: 'image',
  video: 'video',
  webSearch: 'webSearch',
} as const;

/**
 * Whether the operator switched this provider off for the capability (the
 * legacy `<CAP>_<VENDOR>_ENABLED=false` switches), whoever assigns it.
 */
export function isForceDisabled(capability: string, registryId: string): boolean {
  const section = FORCE_OFF_SECTION[capability as keyof typeof FORCE_OFF_SECTION];
  return section !== undefined && isServerProviderDisabled(section, registryId);
}

/** A workspace provider tried to reach a media capability at its own endpoint. */
export class WorkspaceEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceEndpointError';
  }
}

export type MediaSlot = Extract<
  SlotId,
  'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'document'
>;

export interface MediaConnection {
  /** The capability's registry id (e.g. `minimax-tts`, `tavily`). */
  providerId: string;
  /** Absent: the provider's default model. */
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Multi-part credentials (AliDocMind's key pair). */
  credentials?: Record<string, string>;
  proxy?: string;
  /** The provider's non-secret options (openmaic.yml `options`): its adapter's settings. */
  options?: Record<string, string | number | boolean>;
  /** The provider is operator configuration (deployment or server providers). */
  managed: boolean;
  /**
   * The base URL is user input (a client-sent one, a workspace provider's):
   * it runs under the strict public-network policy.
   */
  userEndpoint: boolean;
  /** Where the connection came from. */
  origin: 'configuration' | 'request' | 'default';
}

type Assigned = Extract<SlotResolution, { status: 'assigned' }>;

/**
 * Whether an endpoint names this server's own network by its spelling
 * (localhost, a local name, a private address): the default endpoint of a
 * self-hosted preset. No DNS lookup: the public-only transports check the
 * resolved address when they connect.
 */
export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isIP(host) !== 0 && isPrivateIP(host))
  );
}

async function fromTarget(
  slot: MediaSlot,
  target: ResolvedModelTarget,
  origin: MediaConnection['origin'],
): Promise<MediaConnection> {
  // While the legacy <CAP>_<VENDOR>_ENABLED=false switches are in effect, a
  // provider the operator switched off stays off whoever assigns it.
  if (isForceDisabled(slot, target.registryId)) {
    throw new SlotDisabledError(slot);
  }
  const managed = target.providerSource !== 'workspace';
  if (!managed) {
    // Media, search and document adapters each connect their own way; a
    // workspace provider reaches them only at the preset's own endpoints. A
    // custom endpoint (and a proxy) is the deployment's to configure; for chat
    // a workspace endpoint goes through the pinned, redirect-refusing
    // transport instead (lib/server/model-config/llm.ts).
    if (target.proxy) {
      throw new WorkspaceEndpointError(
        'A proxy can only be configured by the deployment (openmaic.yml)',
      );
    }
    if (target.customBaseUrl) {
      throw new WorkspaceEndpointError(
        `A custom endpoint for ${slot} can only be configured by the deployment (openmaic.yml)`,
      );
    }
    // A self-hosted preset's default endpoint is on the server's own network.
    const endpoint =
      target.baseUrl ?? registryDefaultBaseUrl(getSlot(slot).capability, target.registryId);
    if (endpoint && isLocalEndpoint(endpoint)) {
      throw new WorkspaceEndpointError(
        `The ${target.presetId} preset runs on the server's own network; only the deployment (openmaic.yml) can configure it`,
      );
    }
  }
  return {
    providerId: target.registryId,
    ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
    ...(target.apiKey !== undefined ? { apiKey: target.apiKey } : {}),
    ...(target.baseUrl !== undefined ? { baseUrl: target.baseUrl } : {}),
    ...(target.credentials !== undefined ? { credentials: target.credentials } : {}),
    ...(target.proxy !== undefined ? { proxy: target.proxy } : {}),
    ...(target.options !== undefined ? { options: target.options } : {}),
    managed,
    // A workspace provider reaches only its preset's own public endpoint (a
    // custom one and a local-default preset are refused above), exactly the
    // endpoint a deployment's default would use: no user-typed endpoint, so
    // the transports keep the operator's policy.
    userEndpoint: false,
    origin,
  };
}

/**
 * The connection for a provider target outside slot resolution (a saved
 * provider the settings test), under the same rules as a slot's.
 */
export function mediaConnectionFor(
  slot: MediaSlot,
  target: ResolvedModelTarget,
): Promise<MediaConnection> {
  return fromTarget(slot, target, 'configuration');
}

export interface MediaSlotOptions {
  workspaceId: string | null;
  /**
   * The provider the request names the old way, or undefined when it names
   * none. Consulted only when the configuration leaves the slot unassigned.
   */
  legacyRequest?: () => Promise<MediaConnection | undefined>;
}

/** The connection for a media slot; throws when it is turned off or unassigned. */
export async function resolveMediaSlot(
  slot: MediaSlot,
  { workspaceId, legacyRequest }: MediaSlotOptions,
): Promise<MediaConnection> {
  const lookup = await lookupSlot(slot, workspaceId);
  const { configured } = lookup;
  if (configured.status === 'assigned') return fromTarget(slot, configured, 'configuration');
  if (configured.status === 'disabled') throw new SlotDisabledError(slot);
  const requested = await legacyRequest?.();
  if (requested) return requested;
  const fallback = lookup.defaults();
  if (fallback.status === 'assigned') return fromTarget(slot, fallback as Assigned, 'default');
  if (fallback.status === 'disabled') throw new SlotDisabledError(slot);
  throw new SlotUnassignedError(slot);
}

/**
 * Whether a media slot resolves to a provider, for capability probes: false
 * when it is turned off or has nothing assigned (the request path aside).
 */
export async function mediaSlotAvailable(
  slot: MediaSlot,
  workspaceId: string | null,
): Promise<boolean> {
  const lookup = await lookupSlot(slot, workspaceId);
  if (lookup.configured.status !== 'unassigned') return lookup.configured.status === 'assigned';
  return lookup.defaults().status === 'assigned';
}

/** A provider the request named (deprecated path) was refused with `response`. */
export class RequestedProviderRefusedError extends Error {
  constructor(readonly response: Response) {
    super('the provider the request named was refused');
    this.name = 'RequestedProviderRefusedError';
  }
}

/**
 * The response for a resolution failure a route should answer as such (a
 * capability turned off, nothing configured, a refused credential), or
 * undefined for any other error.
 */
export function mediaResolutionResponse(error: unknown, what: string): Response | undefined {
  if (error instanceof SlotDisabledError) {
    return apiError('PROVIDER_DISABLED', 403, `${what} is turned off on this server`);
  }
  if (error instanceof SlotUnassignedError) {
    return apiError('MISSING_PROVIDER', 400, `No ${what} provider is configured`);
  }
  if (error instanceof InvalidOwnerCredentialError) return invalidOwnerCredentialResponse();
  if (error instanceof RequestedProviderRefusedError) return error.response;
  if (error instanceof WorkspaceEndpointError) return apiError('INVALID_URL', 403, error.message);
  return undefined;
}

/**
 * The connection for background work on behalf of a stored owner (an agent
 * run, a generation job): 'off' when the slot is turned off, null when
 * nothing is assigned. Requests do not name providers here.
 */
export async function serverMediaConnection(
  slot: MediaSlot,
  storedOwnerId?: string,
  {
    forward = true,
  }: {
    /**
     * Follow a claim to the owner the work belongs to now: true for owners
     * taken from durable records; false for a request's own workspace id,
     * which must never become the account's (see requestWorkspaceId).
     */
    forward?: boolean;
  } = {},
): Promise<MediaConnection | 'off' | null> {
  const workspaceId = storedOwnerId
    ? forward
      ? await backgroundWorkspaceId(storedOwnerId)
      : storedOwnerId
    : null;
  try {
    return await resolveMediaSlot(slot, { workspaceId });
  } catch (error) {
    if (error instanceof SlotDisabledError) return 'off';
    if (error instanceof SlotUnassignedError) return null;
    throw error;
  }
}
