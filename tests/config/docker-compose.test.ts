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
    // The default URL lives in the defaults file, so a DATABASE_URL in
    // .env.local (an external database, an encoded password) wins over it;
    // `environment:` would beat .env.local.
    expect(defaultOf(app.environment, 'DATABASE_URL')).toBeUndefined();
    // The same variable initializes the role and builds the default URL.
    expect(readEnvFile('docker-compose.defaults.env').DATABASE_URL).toBe(
      'postgres://openmaic:${PERSISTENCE_POSTGRES_PASSWORD:-openmaic-dev}@postgres:5432/openmaic',
    );
    expect(postgres.environment).toContain(
      'POSTGRES_PASSWORD=${PERSISTENCE_POSTGRES_PASSWORD:-openmaic-dev}',
    );
  });

  it('has no build-time persistence switch: the app is always server-backed', () => {
    expect(JSON.stringify(app.build?.args)).not.toContain('NEXT_PUBLIC_PERSISTENCE');
  });

  it('passes its default DATABASE_URL through boot validation', async () => {
    const { requireDatabaseUrl } = await import('@/lib/server/database-requirement');
    expect(() => requireDatabaseUrl(readEnvFile('docker-compose.defaults.env'))).not.toThrow();
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
    for (const key of ['DATABASE_URL', 'OWNER_SINGLE_USER', 'OWNER_CLAIM_TRIGGER']) {
      expect(defaultOf(app.environment, key), key).toBeUndefined();
    }
  });

  it('defaults to single-user mode and leaves claims explicit', () => {
    const defaults = readEnvFile('docker-compose.defaults.env');
    expect(defaults).toEqual({
      DATABASE_URL: expect.stringMatching(/@postgres:5432\/openmaic$/),
      OWNER_SINGLE_USER: 'true',
    });
    // An automatic claim irreversibly merges every browser's anonymous library
    // into the single owner; it must be an operator's explicit choice.
    expect(defaults).not.toHaveProperty('OWNER_CLAIM_TRIGGER');
    expect(JSON.stringify(app.environment)).not.toContain('OWNER_CLAIM_TRIGGER');
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

describe('docker-compose.db.yml (`pnpm db:up`)', () => {
  const devDb = yaml.load(readFileSync(path.join(root, 'docker-compose.db.yml'), 'utf8')) as {
    services: Record<string, ComposeService & { extends?: { file?: string; service?: string } }>;
    volumes: Record<string, unknown>;
  };
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('starts only the postgres service of docker-compose.yml, on its data volume', () => {
    expect(Object.keys(devDb.services)).toEqual(['postgres']);
    expect(devDb.services.postgres.extends).toEqual({
      file: 'docker-compose.yml',
      service: 'postgres',
    });
    expect(devDb.volumes).toHaveProperty('openmaic-postgres');
  });

  it('publishes the database on loopback only', () => {
    expect(devDb.services.postgres.ports).toEqual(['127.0.0.1:${OPENMAIC_DB_PORT:-5432}:5432']);
  });

  it('is what the db:up and db:down scripts run, and nothing else', () => {
    expect(packageJson.scripts['db:up']).toBe(
      'docker compose -f docker-compose.db.yml up -d --wait postgres',
    );
    expect(packageJson.scripts['db:down']).toBe(
      'docker compose -f docker-compose.db.yml stop postgres',
    );
  });

  it('matches the local DATABASE_URL documented in .env.example', () => {
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(example).toContain(
      '# DATABASE_URL=postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic',
    );
    expect(postgres.environment).toContain('POSTGRES_USER=openmaic');
    expect(postgres.environment).toContain('POSTGRES_DB=openmaic');
  });
});
