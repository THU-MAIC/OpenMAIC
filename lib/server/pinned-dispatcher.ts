/**
 * Pinned undici dispatchers — the connect-time half of the SSRF defence.
 *
 * A URL can pass `validateUrlForSSRF` and then have its hostname resolved
 * again by the HTTP client, so the socket may connect to an address the guard
 * never saw (DNS rebinding). These helpers install a custom `connect.lookup`
 * that resolves ALL addresses, classifies every answer with the caller's
 * policy, and hands the vetted list back to undici. The socket can therefore
 * only connect to an address that was checked in the same lookup, while the
 * URL hostname is left untouched so `Host`, TLS SNI and certificate
 * verification stay normal.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';

import { Agent, type Dispatcher } from 'undici';

import {
  allowLocalNetworksEnabled,
  assertSafeConnectionAddress,
  assertSafeIp,
} from '@/lib/server/ssrf-guard';

/** A per-address policy: throw to refuse the whole DNS answer set. */
export type AddressPolicy = (address: string) => void;

/** The callback-style `net.connect` lookup signature undici invokes. */
type LookupCallback = (...args: unknown[]) => void;

export interface PinnedDispatcherOptions {
  /** Policy applied to every answer; defaults to the strict `assertSafeIp`. */
  assertAddress?: AddressPolicy;
  headersTimeout?: number;
  bodyTimeout?: number;
  connectTimeout?: number;
}

/** Reject the whole DNS answer set if any candidate fails the policy. */
export function assertLookupAddresses(
  addresses: LookupAddress[],
  assertAddress: AddressPolicy,
): void {
  if (addresses.length === 0) throw new Error('DNS returned no addresses');
  for (const answer of addresses) assertAddress(answer.address);
}

/** Strict variant used by the agent runtime; kept exported for its consumers. */
export function assertSafeLookupAddresses(addresses: LookupAddress[]): void {
  assertLookupAddresses(addresses, assertSafeIp);
}

/**
 * Build a `connect.lookup` that resolves every address, runs the policy over
 * each one, and only then answers the connector. Resolving once and reusing
 * the vetted list closes the validate-then-refetch window entirely.
 */
function makePinnedLookup(assertAddress: AddressPolicy) {
  return function lookupAllThenPin(
    hostname: string,
    options: Record<string, unknown>,
    callback: LookupCallback,
  ): void {
    dnsLookup(
      hostname,
      { ...options, all: true, verbatim: true },
      (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
        if (error) {
          callback(error);
          return;
        }
        try {
          assertLookupAddresses(addresses, assertAddress);
        } catch (lookupError) {
          callback(lookupError);
          return;
        }
        if (options.all === true) {
          callback(null, addresses);
        } else {
          const first = addresses[0]!;
          callback(null, first.address, first.family);
        }
      },
    );
  };
}

/** Build an undici Agent whose connection DNS is pinned to vetted answers. */
export function createPinnedAgent(options: PinnedDispatcherOptions = {}): Agent {
  const assertAddress = options.assertAddress ?? assertSafeIp;
  const connect = {
    lookup: makePinnedLookup(assertAddress) as never,
    ...(options.connectTimeout !== undefined ? { timeout: options.connectTimeout } : {}),
  };
  return new Agent({
    ...(options.headersTimeout !== undefined ? { headersTimeout: options.headersTimeout } : {}),
    ...(options.bodyTimeout !== undefined ? { bodyTimeout: options.bodyTimeout } : {}),
    connect,
  });
}

/**
 * A dispatcher that refuses connect-time DNS answers the URL-layer guard would
 * reject. `ALLOW_LOCAL_NETWORKS` is read at call time unless the caller passes
 * `allowLocalNetworks` explicitly; cloud metadata is refused either way.
 */
export function createValidatedDispatcher(
  options: { allowLocalNetworks?: boolean } = {},
): Dispatcher {
  const allowLocalNetworks = options.allowLocalNetworks ?? allowLocalNetworksEnabled();
  return createPinnedAgent({
    assertAddress: (address) => assertSafeConnectionAddress(address, allowLocalNetworks),
  });
}
