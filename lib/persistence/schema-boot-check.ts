/**
 * Bring the persistence schema up as the server starts, and stop the process
 * when the database is one this release must not run against.
 *
 * The provider is otherwise initialized lazily, by the first request or
 * background pass that needs it, and a failure there is answered and retried.
 * That is right for an unreachable database, which may come up a moment later,
 * but not for a refusal no retry can change: a database that records a schema
 * version newer than this release knows (it was upgraded by a newer release),
 * or, outside production, an applied migration whose checksum changed. Such a
 * server would stay up answering every persistence request with a 500, so the
 * refusal exits the process like any other boot failure.
 *
 * Started without being awaited: `register()` must not block on I/O.
 */
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

/** Recognized by name, so a refusal thrown by another copy of the storage package counts. */
const SCHEMA_REFUSALS = new Set(['SchemaVersionAheadError', 'SchemaMigrationChecksumError']);

export function isSchemaRefusal(error: unknown): boolean {
  return error instanceof Error && SCHEMA_REFUSALS.has(error.name);
}

export function startSchemaBootCheck(connectionString: string): Promise<void> {
  return getServerPersistenceProvider(connectionString).then(
    () => undefined,
    async (error: unknown) => {
      if (!isSchemaRefusal(error)) {
        console.error(
          '[persistence] Schema bootstrap failed at startup; retrying on the next request',
          error,
        );
        return;
      }
      const { exitOnBootFailure } = await import('@/lib/server/boot-failure');
      await exitOnBootFailure(error);
    },
  );
}
