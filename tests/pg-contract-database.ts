/**
 * One PostgreSQL database per vitest worker for the `*.pg.test.ts` suites.
 *
 * Every app PostgreSQL suite reads `PG_CONTRACT_URL` and works in a schema of
 * its own, but schemas do not isolate advisory locks: they are database-wide.
 * The application keys them on owner ids (the identity fence every owner write
 * takes, the material quota, the per-owner run limit) and on fixed keys (the
 * schema bootstrap lock, the extraction claim lock). Test files running at the
 * same time in one database therefore wait on each other's locks -- every
 * schema a test boots queues behind every other file's bootstrap, and a claim
 * in one file holds up an owner write of the same id in another -- which made
 * unrelated tests time out, or answer `OWNER_BUSY`, depending on what ran next
 * to them. A deployment never shares its database with another one this way.
 *
 * So each worker gets a database of its own, `<database>_w<VITEST_POOL_ID>`,
 * created on first use and reused by the files that worker runs after it (one
 * at a time; each file still cleans up after itself). The URL is rewritten
 * before any test module reads it. Without `PG_CONTRACT_URL` this does nothing.
 */
import { Client } from 'pg';

const contractUrl = process.env.PG_CONTRACT_URL;

if (contractUrl) {
  const url = new URL(contractUrl);
  const base = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const worker = process.env.VITEST_POOL_ID ?? '1';
  const name = `${base}_w${worker}`;
  if (!/^[A-Za-z0-9_]+$/.test(name) || name.length > 63) {
    throw new Error(`PG_CONTRACT_URL: cannot derive a per-worker database name from "${base}"`);
  }
  const client = new Client({ connectionString: contractUrl });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE ${name}`);
      } catch (error) {
        // Created meanwhile by a worker of a concurrent run: 42P04, or 23505
        // when both inserts reached the catalog's unique index together.
        const code = (error as { code?: string }).code;
        if (code !== '42P04' && code !== '23505') throw error;
      }
    }
  } finally {
    await client.end();
  }
  url.pathname = `/${name}`;
  process.env.PG_CONTRACT_URL = url.toString();
}
