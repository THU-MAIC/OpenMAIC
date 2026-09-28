/**
 * The server's one hard dependency: a PostgreSQL database.
 *
 * Courses, chat history, learner progress and generated media are stored on
 * the server, through the embedded persistence endpoint, in the database
 * DATABASE_URL names. There is no browser-storage fallback, so a server
 * without one could render pages but could not open, save or list a single
 * course. `instrumentation.ts` runs this check first among the fatal boot
 * validations, which turns a missing database into a process that exits at
 * startup with the fix in its message, rather than one that serves errors.
 */

export const DATABASE_URL_REQUIRED_MESSAGE =
  'DATABASE_URL is not set. OpenMAIC stores courses in PostgreSQL and cannot start without a database. ' +
  'For local development, run `pnpm db:up` and set DATABASE_URL in .env.local (see .env.example). ' +
  'For a deployment, set DATABASE_URL to a PostgreSQL database, or use `docker compose up`, which starts one.';

/** Throws unless DATABASE_URL names a database (a blank value counts as unset). */
export function requireDatabaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.DATABASE_URL?.trim()) return;
  throw new Error(DATABASE_URL_REQUIRED_MESSAGE);
}
