/**
 * A one-time warning for a Compose deployment that publishes the app beyond
 * loopback while PostgreSQL still uses the development password the Compose
 * file ships with.
 *
 * The Compose file does not publish the PostgreSQL port, so the default
 * password only guards the Compose network. It is still a well-known
 * credential, and a deployment reachable from other machines should not rely
 * on one. The published address is the one the deployment declares
 * (`OPENMAIC_PUBLISH_ADDRESS`, set by the Compose file); the request peer is
 * never consulted. A warning, never a boot failure.
 */

import { createLogger } from '@/lib/logger';
import { declaredPublishAddress, isLoopbackAddress } from '@/lib/server/publish-address';

const log = createLogger('Persistence');

/** The development password `docker-compose.yml` uses when none is configured. */
export const COMPOSE_DEFAULT_POSTGRES_PASSWORD = 'openmaic-dev';

function databasePassword(connectionString: string): string | undefined {
  try {
    const password = new URL(connectionString).password;
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}

let warned = false;

/** Warn once when the declared published address is not loopback and the database password is the default. */
export function warnIfDefaultDatabasePasswordIsPublished(): void {
  if (warned) return;
  const publishAddress = declaredPublishAddress();
  if (publishAddress === undefined || isLoopbackAddress(publishAddress)) return;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return;
  if (databasePassword(connectionString) !== COMPOSE_DEFAULT_POSTGRES_PASSWORD) return;
  warned = true;
  log.warn(
    `The app is published on ${publishAddress} but PostgreSQL still uses the development ` +
      'password from docker-compose.yml. Set PERSISTENCE_POSTGRES_PASSWORD to a long random ' +
      'value (README "Server-backed persistence" explains how to change it for an existing volume).',
  );
}

/** Reset the once-per-process guard. Exists mainly for tests. */
export function resetDatabasePasswordWarningForTests(): void {
  warned = false;
}
