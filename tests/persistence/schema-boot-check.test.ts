import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getServerPersistenceProvider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/persistence/server-provider', () => ({ getServerPersistenceProvider }));
const exitOnBootFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/boot-failure', () => ({ exitOnBootFailure }));

import { startSchemaBootCheck } from '@/lib/persistence/schema-boot-check';

function named(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('schema check at startup', () => {
  beforeEach(() => {
    getServerPersistenceProvider.mockReset();
    exitOnBootFailure.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('brings the provider up for the configured database', async () => {
    getServerPersistenceProvider.mockResolvedValue({});

    await startSchemaBootCheck('postgres://db/openmaic');

    expect(getServerPersistenceProvider).toHaveBeenCalledWith('postgres://db/openmaic');
    expect(exitOnBootFailure).not.toHaveBeenCalled();
  });

  it.each(['SchemaVersionAheadError', 'SchemaMigrationChecksumError'])(
    'stops the process on a %s',
    async (name) => {
      const refusal = named(name);
      getServerPersistenceProvider.mockRejectedValue(refusal);

      await startSchemaBootCheck('postgres://db/openmaic');

      expect(exitOnBootFailure).toHaveBeenCalledWith(refusal);
    },
  );

  it('leaves any other failure to the next request, and says so', async () => {
    getServerPersistenceProvider.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await startSchemaBootCheck('postgres://db/openmaic');

    expect(exitOnBootFailure).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/retrying on the next request/),
      expect.any(Error),
    );
  });
});
