/**
 * The pinned transports for image/video provider requests.
 *
 * A provider base URL may come from the caller (honored when the provider is
 * not server-managed) and runs under the operator address policy — the one the
 * routes validated it against (`allowLocalNetworks` unset falls back to
 * ALLOW_LOCAL_NETWORKS), so a self-hosted provider on a local network keeps
 * working when the operator opted in. A server-managed provider's base URL is
 * operator configuration and may point at a local network without the opt-in;
 * cloud metadata and reserved ranges stay refused under both policies. Either
 * way the connect address is pinned to the vetted DNS answers and a 3xx is
 * refused rather than followed.
 *
 * The adapters live in modules the settings UI also imports, so they cannot
 * import this server transport themselves; every server caller injects it
 * through the config's `fetchImpl`.
 */
import {
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import type { MediaProviderFetch } from '@/lib/media/types';

const MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
};

const MANAGED_MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: true,
  rejectRedirects: true,
};

/** Transport for a caller-supplied (or catalog default) provider base URL. */
export const mediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, MEDIA_PROVIDER_POLICY);

/** Transport for a server-managed provider, whose base URL is operator configuration. */
export const managedMediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, MANAGED_MEDIA_PROVIDER_POLICY);

/**
 * Transport for downloading a finished clip from a provider-returned file URI
 * (`VideoGenerationConfig.downloadFetchImpl`). Unlike the transports above it
 * follows a redirect — a file URI may answer with one to storage — but every
 * hop is re-validated under the operator address policy, pinned to the vetted
 * DNS answers, and stripped of credential headers once it leaves the origin.
 */
export const mediaDownloadFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, { allowLocalNetworks: undefined });

/**
 * {@link mediaDownloadFetch} for a server-managed provider: its origin may sit
 * on a local network, but the hops it redirects to stay on the operator policy.
 */
export const managedMediaDownloadFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, {
    allowLocalNetworks: true,
    redirectAllowLocalNetworks: resolveAllowLocalNetworks(),
  });

const PUBLIC_MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  rejectRedirects: true,
};

/**
 * Transport for a provider a workspace configured (RFC #1701): its endpoint is
 * user input, so it runs under the strict public policy whatever the operator
 * opted into for their own backends.
 */
export const publicMediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, PUBLIC_MEDIA_PROVIDER_POLICY);

/** {@link mediaDownloadFetch} under the strict public policy, every hop included. */
export const publicMediaDownloadFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, { allowLocalNetworks: false });

/**
 * Whose address policy a connection runs under: the operator's own provider
 * (`managed`, local networks allowed), a workspace's (`public`), or a
 * deprecated per-request one (`operator`, the operator's opt-in).
 */
export type MediaNetworkPolicy = 'managed' | 'operator' | 'public';

/** The policy for a resolved media connection. */
export function mediaNetworkPolicy(connection: {
  managed: boolean;
  origin: 'configuration' | 'request' | 'default';
}): MediaNetworkPolicy {
  if (connection.managed) return 'managed';
  return connection.origin === 'configuration' ? 'public' : 'operator';
}

const PROVIDER_FETCH: Record<MediaNetworkPolicy, MediaProviderFetch> = {
  managed: managedMediaProviderFetch,
  operator: mediaProviderFetch,
  public: publicMediaProviderFetch,
};

const DOWNLOAD_FETCH: Record<MediaNetworkPolicy, MediaProviderFetch> = {
  managed: managedMediaDownloadFetch,
  operator: mediaDownloadFetch,
  public: publicMediaDownloadFetch,
};

/** The request and download transports for a policy (true/false: managed/operator). */
export function mediaTransports(policy: MediaNetworkPolicy | boolean): {
  fetchImpl: MediaProviderFetch;
  downloadFetchImpl: MediaProviderFetch;
} {
  const key = policy === true ? 'managed' : policy === false ? 'operator' : policy;
  return { fetchImpl: PROVIDER_FETCH[key], downloadFetchImpl: DOWNLOAD_FETCH[key] };
}

/** `config` with the pinned media transport for its provider installed. */
export function withMediaProviderFetch<T extends object>(
  config: T,
  policy: MediaNetworkPolicy | boolean,
): T & { fetchImpl: MediaProviderFetch } {
  return { ...config, fetchImpl: mediaTransports(policy).fetchImpl };
}

/**
 * {@link withMediaProviderFetch} for video generation, also installing the
 * redirect-following transport for the finished clip's download.
 */
export function withVideoProviderFetch<T extends object>(
  config: T,
  policy: MediaNetworkPolicy | boolean,
): T & { fetchImpl: MediaProviderFetch; downloadFetchImpl: MediaProviderFetch } {
  return { ...config, ...mediaTransports(policy) };
}
