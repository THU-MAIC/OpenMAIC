/**
 * The address a deployment declares its port is published on.
 *
 * Route handlers cannot see the TCP peer of a request, and forwarding headers
 * are client-controlled, so nothing here inspects a request. Instead the
 * deployment states where it publishes the app: `docker-compose.yml` passes
 * the same `OPENMAIC_PUBLISH_ADDRESS` it binds the host port with into the
 * container. Unset means "not declared" (a non-Compose deployment), and
 * callers treat that as unknown rather than safe.
 */

export const PUBLISH_ADDRESS_ENV = 'OPENMAIC_PUBLISH_ADDRESS';

/**
 * Whether `address` is a loopback host: `localhost`, `127.0.0.0/8` or `::1`
 * (bracketed or not). Anything else, including `0.0.0.0` and `::`, counts as
 * exposed.
 */
export function isLoopbackAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (value === 'localhost' || value === '::1') return true;
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/** The published address the deployment declares, or `undefined` when it declares none. */
export function declaredPublishAddress(): string | undefined {
  return process.env[PUBLISH_ADDRESS_ENV]?.trim() || undefined;
}
