import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifySchemaMigrations = vi.hoisted(() => vi.fn());
vi.mock('@openmaic/storage/pg-migrations', () => ({ verifySchemaMigrations }));
const exitOnBootFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/boot-failure', () => ({ exitOnBootFailure }));

import { startSchemaBootCheck } from '@/lib/persistence/schema-boot-check';
import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('schema check at startup', () => {
  const end = vi.fn(async () => {});
  const pool = { end } as unknown as Pool;
  const poolFactory = vi.fn(() => pool);

  beforeEach(() => {
    verifySchemaMigrations.mockReset();
    exitOnBootFailure.mockReset();
    end.mockClear();
    poolFactory.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies every store the application knows, on a pool of its own it then closes', async () => {
    verifySchemaMigrations.mockResolvedValue(undefined);

    await startSchemaBootCheck(' postgres://db/openmaic ', poolFactory);

    expect(poolFactory).toHaveBeenCalledWith('postgres://db/openmaic');
    expect(verifySchemaMigrations).toHaveBeenCalledWith(pool, APP_SCHEMA_STORES);
    expect(end).toHaveBeenCalledOnce();
    expect(exitOnBootFailure).not.toHaveBeenCalled();
  });

  it.each(['SchemaVersionAheadError', 'SchemaMigrationChecksumError'])(
    'stops the process on a %s',
    async (name) => {
      const refusal = named(name);
      verifySchemaMigrations.mockRejectedValue(refusal);

      await startSchemaBootCheck('postgres://db/openmaic', poolFactory);

      expect(exitOnBootFailure).toHaveBeenCalledWith(refusal);
    },
  );

  it('leaves any other failure to the stores, and says so', async () => {
    verifySchemaMigrations.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await startSchemaBootCheck('postgres://db/openmaic', poolFactory);

    expect(exitOnBootFailure).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/checks them again when it is first used/),
      expect.any(Error),
    );
  });
});
