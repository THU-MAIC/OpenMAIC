import type { ConnectionOptions } from 'node:tls';

/**
 * TLS for the app's own PostgreSQL connections.
 *
 * `DATABASE_CA_CERT` holds the PEM of the CA that signed the database's
 * certificate (Supabase: "Supabase Root 2021 CA", public). When it is set,
 * every connection is encrypted and the server must prove it is the one that
 * CA vouches for; when it is unset nothing changes, so the local Compose stack
 * keeps its plaintext socket.
 *
 * Why not `?sslmode=require` in `DATABASE_URL`: node-postgres now reads it as
 * `verify-full` against the system trust store, which does not hold private
 * CAs like Supabase's, so the connection is refused outright. The tempting
 * escape (`sslmode=no-verify`) encrypts but accepts any certificate. Pinning
 * the CA is the only spelling that is both working and verified. An `ssl*`
 * parameter left in `DATABASE_URL` still wins over this — node-postgres merges
 * the URL last.
 *
 * Vercel's editor keeps newlines, but a value pasted through a single-line
 * field arrives with literal `\n`; both spellings are accepted.
 */
export function databaseTlsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConnectionOptions | undefined {
  const ca = env.DATABASE_CA_CERT?.trim();
  if (!ca) return undefined;
  return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
}
