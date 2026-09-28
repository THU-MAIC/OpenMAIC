/**
 * Course tenancy lives in `stage_meta` alone, on PGlite: a fresh install has
 * no ownership column on `document_stages`, and an upgraded one is adopted at
 * boot. The same scenarios run on PostgreSQL in the `.pg` suite.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  freshInstallScenario,
  upgradeScenario,
  type ScenarioPool,
} from './_stage-meta-tenancy-scenarios';

class PGlitePool implements ScenarioPool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

describe('course tenancy in stage_meta (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('DATABASE_URL', `postgres://tenancy-${randomUUID()}`);
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('a fresh install scopes every course through stage_meta, with no ownership column', async () => {
    await freshInstallScenario(pool);
  });

  it('an upgrade adopts column-only owners at boot, loses nothing, and is idempotent', async () => {
    await upgradeScenario(pool);
  });
});
