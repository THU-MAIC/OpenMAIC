/**
 * Course tenancy lives in `stage_meta` alone, on a real PostgreSQL: the same
 * scenarios as the PGlite suite, each in a schema of its own so the legacy
 * tables never meet the storage package's contract suites.
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';

import { freshInstallScenario, upgradeScenario } from './_stage-meta-tenancy-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_stage_meta_tenancy_test';

describe.skipIf(!contractUrl)('course tenancy in stage_meta (PostgreSQL)', () => {
  let admin: Pool;
  let pool: Pool;
  const previousBucket = process.env.ASSET_S3_BUCKET;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    process.env.ASSET_S3_BUCKET = '';
  });

  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
      max: 6,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  afterAll(async () => {
    if (previousBucket === undefined) delete process.env.ASSET_S3_BUCKET;
    else process.env.ASSET_S3_BUCKET = previousBucket;
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('a fresh install scopes every course through stage_meta, with no ownership column', async () => {
    await freshInstallScenario(pool);
  });

  it('an upgrade adopts column-only owners at boot, loses nothing, and is idempotent', async () => {
    await upgradeScenario(pool);
  });
});
