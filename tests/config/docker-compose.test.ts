import { readFileSync } from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetOwnerAuthenticationForTests,
  validateOwnerIdentityConfiguration,
} from '@/lib/server/identity/registry';

/**
 * The shipped Compose deployment: `docker compose up` starts PostgreSQL and a
 * server-backed app in single-user mode, published on loopback only. These pin
 * the file's shape, and that its defaults pass the app's own boot validation.
 */

const root = path.resolve(__dirname, '../..');

interface ComposeService {
  profiles?: string[];
  ports?: string[];
  env_file?: string[];
  environment?: string[];
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: unknown };
  volumes?: string[];
  build?: { args?: string[] };
}

const compose = yaml.load(readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};
const app = compose.services.openmaic;
const postgres = compose.services.postgres;

/** `KEY=value` lines of an env file, comments and blanks skipped. */
function readEnvFile(file: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path.join(root, file), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    entries[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return entries;
}

/** The value of `KEY=${VAR:-default}` (or a literal) with no variable set, as Compose resolves it. */
function defaultOf(entries: string[] | undefined, key: string): string | undefined {
  const entry = entries?.find((value) => value.startsWith(`${key}=`));
  if (entry === undefined) return undefined;
  return entry
    .slice(key.length + 1)
    .replace(/\$\{[A-Z0-9_]+:?-([^}]*)\}/g, '$1')
    .replace(/\$\{[A-Z0-9_]+\}/g, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
});

describe('docker-compose.yml', () => {
  it('starts PostgreSQL by default, with a health check and a named volume', () => {
    expect(postgres.profiles).toBeUndefined();
    expect(JSON.stringify(postgres.healthcheck?.test)).toContain('pg_isready');
    expect(postgres.volumes).toContain('openmaic-postgres:/var/lib/postgresql/data');
    expect(compose.volumes).toHaveProperty('openmaic-postgres');
    // Not published to the host: only the app on the Compose network reaches it.
    expect(postgres.ports).toBeUndefined();
  });

  it('starts the app only once PostgreSQL is healthy, wired to it', () => {
    expect(app.profiles).toBeUndefined();
    expect(app.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(defaultOf(app.environment, 'DATABASE_URL')).toBe(
      'postgres://openmaic:openmaic-dev@postgres:5432/openmaic',
    );
    // The same variable initializes the role and builds the app's URL.
    expect(app.environment).toContain(
      'DATABASE_URL=postgres://openmaic:${PERSISTENCE_POSTGRES_PASSWORD:-openmaic-dev}@postgres:5432/openmaic',
    );
    expect(postgres.environment).toContain(
      'POSTGRES_PASSWORD=${PERSISTENCE_POSTGRES_PASSWORD:-openmaic-dev}',
    );
  });

  it('builds a server-backed browser bundle unless told otherwise', () => {
    expect(app.build?.args).toContain('NEXT_PUBLIC_PERSISTENCE=${NEXT_PUBLIC_PERSISTENCE-1}');
  });

  it('publishes the app on loopback by default, from the variable it passes to the app', () => {
    expect(app.ports).toEqual([
      '${OPENMAIC_PUBLISH_ADDRESS:-127.0.0.1}:${OPENMAIC_PORT:-3000}:3000',
    ]);
    expect(app.environment).toContain(
      'OPENMAIC_PUBLISH_ADDRESS=${OPENMAIC_PUBLISH_ADDRESS:-127.0.0.1}',
    );
  });

  it('reads its defaults before .env.local, so .env.local overrides them', () => {
    expect(app.env_file).toEqual(['docker-compose.defaults.env', '.env.local']);
    // Keys in `environment` would beat .env.local; the owner settings must not be there.
    for (const key of ['OWNER_SINGLE_USER', 'OWNER_CLAIM_TRIGGER']) {
      expect(defaultOf(app.environment, key), key).toBeUndefined();
    }
  });

  it('defaults to single-user mode with automatic claims', () => {
    expect(readEnvFile('docker-compose.defaults.env')).toEqual({
      OWNER_SINGLE_USER: 'true',
      OWNER_CLAIM_TRIGGER: 'auto',
    });
  });

  function stubComposeEnvironment(publishAddress: string, accessCode = ''): void {
    for (const [key, value] of Object.entries(readEnvFile('docker-compose.defaults.env'))) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    vi.stubEnv('ACCESS_CODE', accessCode);
    vi.stubEnv('OPENMAIC_PUBLISH_ADDRESS', publishAddress);
  }

  it('boots in single-user mode with its defaults on the default address', () => {
    stubComposeEnvironment(defaultOf(app.environment, 'OPENMAIC_PUBLISH_ADDRESS')!);
    expect(validateOwnerIdentityConfiguration()).toBe('singleUser');
  });

  it('also boots when published on the network, with or without ACCESS_CODE', () => {
    stubComposeEnvironment('0.0.0.0');
    expect(validateOwnerIdentityConfiguration()).toBe('singleUser');
    stubComposeEnvironment('0.0.0.0', 'demo-code-that-is-long-enough');
    expect(validateOwnerIdentityConfiguration()).toBe('singleUser');
  });
});
