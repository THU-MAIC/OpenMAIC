/**
 * Neon Postgres adapter for persistent JSON storage.
 *
 * Used for classroom jobs and classroom content.
 * Binary files (TTS audio, images) stay on Vercel Blob.
 *
 * Required env var: NEON_DATABASE_URL
 * Run lib/server/neon-schema.sql once against your openmaic database to create tables.
 */

import { neon } from '@neondatabase/serverless';
import { createLogger } from '@/lib/logger';

const log = createLogger('NeonStore');

export const USE_NEON = !!process.env.NEON_DATABASE_URL;

let _sql: ReturnType<typeof neon> | null = null;

function getSql() {
  if (!_sql) {
    if (!process.env.NEON_DATABASE_URL) throw new Error('NEON_DATABASE_URL is not set');
    _sql = neon(process.env.NEON_DATABASE_URL);
  }
  return _sql;
}

export async function neonSelect<T>(query: string, params: unknown[]): Promise<T[]> {
  try {
    const rows = await getSql()(query, params);
    return rows as T[];
  } catch (error) {
    log.error('Neon query failed:', error);
    throw error;
  }
}

export async function neonExec(query: string, params: unknown[]): Promise<void> {
  try {
    await getSql()(query, params);
  } catch (error) {
    log.error('Neon exec failed:', error);
    throw error;
  }
}
