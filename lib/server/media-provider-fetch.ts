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

/** `config` with the pinned media transport for its provider installed. */
export function withMediaProviderFetch<T extends object>(
  config: T,
  managed: boolean,
): T & { fetchImpl: MediaProviderFetch } {
  return { ...config, fetchImpl: managed ? managedMediaProviderFetch : mediaProviderFetch };
}

/**
 * {@link withMediaProviderFetch} for video generation, also installing the
 * redirect-following transport for the finished clip's download.
 */
export function withVideoProviderFetch<T extends object>(
  config: T,
  managed: boolean,
): T & { fetchImpl: MediaProviderFetch; downloadFetchImpl: MediaProviderFetch } {
  return {
    ...withMediaProviderFetch(config, managed),
    downloadFetchImpl: managed ? managedMediaDownloadFetch : mediaDownloadFetch,
  };
}
