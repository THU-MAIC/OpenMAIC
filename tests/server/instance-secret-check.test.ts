import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { instanceSecretWarnings, storedSecretKids } from '@/lib/server/instance-secret-check';
import {
  inspectInstanceSecret,
  instanceKey,
  resetInstanceKeyForTests,
  type InstanceSecretState,
} from '@/lib/server/secret-box';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-secret-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  resetInstanceKeyForTests();
});

describe('inspectInstanceSecret', () => {
  it('names the configured secret without touching the data directory', () => {
    const dataDir = path.join(tempDir(), 'data');
    const state = inspectInstanceSecret({ OPENMAIC_SECRET_KEY: 'configured' }, dataDir);
    expect(state).toMatchObject({ configured: true, fileExists: false, dataDirWritable: true });
    expect(state.kid).toBe(instanceKey({ OPENMAIC_SECRET_KEY: 'configured' }, dataDir).kid);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('creates nothing when the secret file is missing', () => {
    const dataDir = path.join(tempDir(), 'data');
    const state = inspectInstanceSecret({}, dataDir);
    expect(state).toMatchObject({ configured: false, fileExists: false, dataDirWritable: true });
    expect(state.kid).toBeUndefined();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('reads the key id of an existing secret file', () => {
    const dataDir = tempDir();
    const kid = instanceKey({}, dataDir).kid;
    expect(inspectInstanceSecret({}, dataDir)).toMatchObject({ fileExists: true, kid });
  });

  it.skipIf(process.getuid?.() === 0)('sees a data directory that cannot be written', () => {
    const root = tempDir();
    fs.chmodSync(root, 0o500);
    expect(inspectInstanceSecret({}, path.join(root, 'data')).dataDirWritable).toBe(false);
  });
});

describe('instanceSecretWarnings', () => {
  const state = (overrides: Partial<InstanceSecretState> = {}): InstanceSecretState => ({
    configured: false,
    file: 'data/instance-secret.key',
    fileExists: false,
    dataDirWritable: true,
    ...overrides,
  });

  it('is quiet when nothing is stored and a secret can be created or read', () => {
    expect(instanceSecretWarnings(state(), {})).toEqual([]);
    expect(instanceSecretWarnings(state({ fileExists: true, kid: 'a' }), {})).toEqual([]);
    expect(instanceSecretWarnings(state({ configured: true, kid: 'a' }), {})).toEqual([]);
  });

  it('is quiet when every stored key opens under the current secret', () => {
    expect(instanceSecretWarnings(state({ fileExists: true, kid: 'a' }), { a: 3 })).toEqual([]);
    expect(instanceSecretWarnings(state({ configured: true, kid: 'a' }), { a: 3 })).toEqual([]);
  });

  it('warns when no secret can be created in a read-only data directory', () => {
    const [warning] = instanceSecretWarnings(state({ dataDirWritable: false }), {});
    expect(warning).toMatch(/OPENMAIC_SECRET_KEY is not set/);
    expect(warning).toMatch(/not writable/);
    expect(warning).toMatch(/saving a provider key .* will fail/);
    // An existing file, or the variable, needs no write.
    expect(
      instanceSecretWarnings(state({ dataDirWritable: false, fileExists: true, kid: 'a' }), {}),
    ).toEqual([]);
    expect(
      instanceSecretWarnings(state({ dataDirWritable: false, configured: true, kid: 'a' }), {}),
    ).toEqual([]);
  });

  it('warns when a new secret file would be generated over keys sealed earlier', () => {
    const [warning] = instanceSecretWarnings(state(), { old: 2, older: 1 });
    expect(warning).toMatch(/3 provider key\(s\)/);
    expect(warning).toMatch(/A new secret will be generated/);
    expect(warning).toMatch(/entered again/);
    expect(warning).toMatch(/Set OPENMAIC_SECRET_KEY/);
  });

  it('warns about stored keys sealed under a different secret than the current one', () => {
    const [fromFile] = instanceSecretWarnings(state({ fileExists: true, kid: 'new' }), {
      new: 4,
      old: 2,
    });
    expect(fromFile).toMatch(/^2 provider key\(s\)/);
    expect(fromFile).toMatch(/data\/instance-secret\.key/);
    expect(fromFile).toMatch(/Set OPENMAIC_SECRET_KEY/);
    const [fromEnv] = instanceSecretWarnings(state({ configured: true, kid: 'new' }), { old: 1 });
    expect(fromEnv).toMatch(/current one \(OPENMAIC_SECRET_KEY\)/);
  });
});

describe('storedSecretKids', () => {
  it('counts nothing before the settings table exists', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const queryable = {
      query: async () => {
        throw missing;
      },
    };
    expect(await storedSecretKids(queryable as never)).toEqual({});
  });

  it('reports other database errors', async () => {
    const queryable = {
      query: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(storedSecretKids(queryable as never)).rejects.toThrow('connection refused');
  });
});
