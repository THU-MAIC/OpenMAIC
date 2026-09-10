import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Assert that @openmaic/storage's PostgreSQL contract suites really exercised a
 * real PostgreSQL, from evidence that cannot be produced by editing the tests.
 *
 * WHY THIS EXISTS AT ALL. The suites already refuse to skip when
 * STORAGE_PG_CONTRACT_REQUIRED=1, but that refusal is a `throw` inside the test
 * modules, so it cannot fire if vitest stops collecting them. Collection is
 * decided by `packages/@openmaic/storage/vitest.config.ts`, and both that file
 * and the whole `test/` directory are on the ignore list of publishable inputs
 * in `check-package-version-bumps.mjs`. The entire surface those suites live on
 * can therefore be rewritten with no version bump and no release gate noticing.
 *
 * WHY THE VITEST RESULTS ARE NOT ENOUGH ON THEIR OWN. `assertionResults` are
 * test CASES, not `expect()` calls, so a file named `pg-document-store.pg.test.ts`
 * containing nothing but `test('x', () => {})` satisfies every check in phase 1
 * below. And because `test/setup.ts` is already wired as `setupFiles`, a single
 * `vi.mock('pg', ...)` there makes both suites collect, run and pass green
 * against an in-memory fake. Both edits are one line, in `test/`, and need no
 * version bump. Phase 1 therefore proves only that two files with those names
 * ran and reported passing cases — nothing whatsoever about a database.
 *
 * WHAT PHASE 2 ADDS. It connects to the contract database from OUTSIDE the
 * vitest process and asks PostgreSQL itself what happened: the five tables
 * these two backends own must exist, and each must have gained inserts DURING
 * the run. Nothing inside `test/` can forge that, because producing it requires
 * actually writing to the database this script independently connects to.
 *
 * Insert counters rather than surviving rows: the suites clean up after
 * themselves, so counting rows would prove nothing, while `n_tup_ins` survives
 * the cleanup. Counted as a delta against a baseline captured before the run
 * rather than as an absolute, so a non-ephemeral database cannot satisfy the
 * check forever on the strength of some earlier run. Both current workflows use
 * a fresh per-job service container, but this check should not depend on that
 * staying true.
 *
 * ── THREAT MODEL, STATED HONESTLY ────────────────────────────────────────────
 *
 * What this proves: during this run, rows were inserted into those five tables
 * in a real PostgreSQL, and two files with the contract suites' names ran and
 * passed.
 *
 * What it does NOT prove: that the built `PgDocumentStore` and `PgRuntimeStore`
 * were the code that inserted them. The whole `test/` directory is on the
 * publishable-input ignore list, so test code can create the schema and insert
 * directly, and this audit would read the same either way. Closing that needs a
 * harness living outside the ignored `test/` surface — separate work, not
 * attempted here.
 *
 * That limit is acceptable because of who each threat is. This guard exists to
 * catch ACCIDENTAL silencing: a vitest `include`/`exclude` change, a missing
 * environment variable, a renamed suite file, a dropped workflow step. Those
 * are the ways this coverage actually disappears, and they are all caught.
 * It is not a defence against someone deliberately faking coverage from inside
 * `test/` — and it does not need to be, because that person can merge changes
 * to the production sources just as easily.
 */

const REQUIRED_SUITES = [
  'packages/@openmaic/storage/test/pg-document-store.pg.test.ts',
  'packages/@openmaic/storage/test/pg-runtime-store.pg.test.ts',
  'packages/@openmaic/storage/test/pg-scene-revision.pg.test.ts',
];

/**
 * The tables created by `DOCUMENT_PG_SCHEMA` and `RUNTIME_PG_SCHEMA`. Kept
 * explicit rather than parsed out of those sources: this list is the
 * independent statement of what the contract must have touched, and deriving it
 * from the code under test would let that code narrow its own audit.
 */
const REQUIRED_TABLES = [
  'document_stages',
  'document_scenes',
  'document_outlines',
  'document_stage_revision',
  'document_scene_revision',
  'runtime_sessions',
  'runtime_records',
];

const usage = [
  'Usage:',
  '  assert-pg-contract-suites.mjs --capture-baseline <file>',
  '      Record the current insert counters. Run BEFORE the vitest invocation.',
  '  assert-pg-contract-suites.mjs <vitest-json-results> --baseline <file>',
  '      Audit the run against that baseline. Run AFTER the vitest invocation.',
].join('\n');

// Parsed by consuming each flag with its value, so the remaining positionals
// are exactly the positionals. Scanning for "the first argument that does not
// start with --" would silently accept a flag's value as the results path.
const argv = process.argv.slice(2);
let capturingBaseline = false;
let baselinePath;
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--baseline' || arg === '--capture-baseline') {
    capturingBaseline ||= arg === '--capture-baseline';
    i += 1;
    baselinePath = argv[i];
    if (baselinePath === undefined) {
      console.error(`${arg} needs a file path.\n\n${usage}`);
      process.exit(2);
    }
    continue;
  }
  if (arg.startsWith('--')) {
    console.error(`Unknown option ${arg}.\n\n${usage}`);
    process.exit(2);
  }
  positionals.push(arg);
}

const expectedPositionals = capturingBaseline ? 0 : 1;
if (!baselinePath || positionals.length !== expectedPositionals) {
  console.error(usage);
  process.exit(2);
}
const resultsPath = positionals[0];

const contractUrl = process.env.PG_CONTRACT_URL;
if (!contractUrl) {
  console.error(
    'PG_CONTRACT_URL is unset, so there is no database to audit and this check cannot ' +
      'establish that the PostgreSQL contract ran. Invoke it in the same job, with the ' +
      'same PG_CONTRACT_URL, as the vitest run it is auditing.',
  );
  process.exit(2);
}

// The database side -----------------------------------------------------------

// `pg` is a devDependency of @openmaic/storage, not of the repository root, so
// resolve it from the package that owns it rather than assuming hoisting.
const requireFromStorage = createRequire(
  new URL('../packages/@openmaic/storage/package.json', import.meta.url),
);
const { Client } = requireFromStorage('pg');

async function collectInsertCounts(client) {
  const { rows } = await client.query(
    `SELECT t.relname AS table_name,
            to_regclass('public.' || t.relname) IS NOT NULL AS present,
            COALESCE(s.n_tup_ins, 0)::bigint AS inserts
       FROM unnest($1::text[]) AS t(relname)
       LEFT JOIN pg_stat_user_tables s
              ON s.schemaname = 'public' AND s.relname = t.relname`,
    [REQUIRED_TABLES],
  );
  return Object.fromEntries(
    rows.map((row) => [row.table_name, { present: row.present, inserts: Number(row.inserts) }]),
  );
}

/**
 * Read the counters, optionally waiting for them to move past `baseline`.
 *
 * Backends flush statistics at transaction end and on exit, so by the time
 * vitest has returned they are normally already visible. Re-read a few times
 * anyway rather than racing a slow flush, discarding the per-session snapshot
 * each round because a backend caches it for the whole transaction. A flush
 * that never arrives fails the check rather than passing it.
 */
async function readCounters({ waitFor } = {}) {
  const client = new Client({ connectionString: contractUrl });
  try {
    await client.connect();
    let counts = await collectInsertCounts(client);
    if (!waitFor) return counts;
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const unproven = REQUIRED_TABLES.filter(
        (table) => !(counts[table]?.inserts > (waitFor[table]?.inserts ?? 0)),
      );
      if (unproven.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query('SELECT pg_stat_clear_snapshot()');
      counts = await collectInsertCounts(client);
    }
    return counts;
  } catch (error) {
    console.error(
      `Cannot reach the contract database at PG_CONTRACT_URL: ${error.message}. ` +
        'Without it there is no evidence the suites touched a real PostgreSQL.',
    );
    process.exit(2);
  } finally {
    await client.end().catch(() => {});
  }
}

if (capturingBaseline) {
  const baseline = await readCounters();
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  const summary = REQUIRED_TABLES.map((table) => `${table}=${baseline[table]?.inserts ?? 0}`);
  console.log(`Captured contract-database baseline to ${baselinePath}: ${summary.join(' ')}.`);
  process.exit(0);
}

// Phase 1 ---------------------------------------------------------------------
// The two suite files were collected and reported passing cases.

let results;
try {
  results = JSON.parse(readFileSync(resultsPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read the vitest results at ${resultsPath}: ${error.message}`);
  process.exit(2);
}

const files = Array.isArray(results.testResults) ? results.testResults : undefined;
if (!files) {
  console.error(
    `${resultsPath} has no testResults array, so it cannot show which suites ran. ` +
      'Was the run invoked with the json reporter?',
  );
  process.exit(2);
}

const failures = [];
for (const suite of REQUIRED_SUITES) {
  // The reporter records absolute paths; match on the repository-relative tail.
  const entry = files.find((file) => typeof file.name === 'string' && file.name.endsWith(suite));
  if (!entry) {
    failures.push(
      `${suite} did not run, so the PostgreSQL contract is unverified. ` +
        "Check vitest's `include`/`exclude` in packages/@openmaic/storage/vitest.config.ts.",
    );
    continue;
  }
  const cases = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
  const passed = cases.filter((testCase) => testCase.status === 'passed').length;
  const pending = cases.filter((testCase) => testCase.status !== 'passed');
  if (entry.status !== 'passed') {
    failures.push(`${suite} reported status "${entry.status}".`);
    continue;
  }
  if (passed === 0) {
    failures.push(`${suite} ran but reported no passing test cases, so it asserted nothing.`);
    continue;
  }
  if (pending.length > 0) {
    failures.push(
      `${suite} left ${pending.length} test case(s) not passing ` +
        `(${[...new Set(pending.map((testCase) => testCase.status))].join(', ')}).`,
    );
    continue;
  }
  console.log(`${suite}: ${passed} test cases ran and passed.`);
}

if (failures.length > 0) {
  console.error(
    [
      'The PostgreSQL contract suites did not run as required:',
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

// Phase 2 ---------------------------------------------------------------------
// PostgreSQL's own account of what changed during the run.

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(
    `Cannot read the pre-run baseline at ${baselinePath}: ${error.message}. Capture it with ` +
      '`--capture-baseline` before the vitest step; without it, counters left by an earlier ' +
      'run against a non-ephemeral database would satisfy this check forever.',
  );
  process.exit(2);
}

const counts = await readCounters({ waitFor: baseline });

const databaseFailures = [];
for (const table of REQUIRED_TABLES) {
  const observed = counts[table];
  const before = baseline[table]?.inserts ?? 0;
  if (!observed?.present) {
    databaseFailures.push(
      `${table} does not exist in the contract database, so the suites never created it ` +
        'and did not run against this PostgreSQL.',
    );
    continue;
  }
  const gained = observed.inserts - before;
  if (!(gained > 0)) {
    databaseFailures.push(
      `${table} exists but gained no inserts during this run (before ${before}, after ` +
        `${observed.inserts}), so the suites did not write to this database. Check for a ` +
        'mocked driver in packages/@openmaic/storage/test/setup.ts, or a stubbed-out suite body.',
    );
    continue;
  }
  console.log(`${table}: ${gained} inserts during this run (${before} -> ${observed.inserts}).`);
}

if (databaseFailures.length > 0) {
  console.error(
    [
      'The contract database shows no evidence that these suites wrote to it during this run:',
      ...databaseFailures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `Verified: the required contract suite files ran and passed, and all ${REQUIRED_TABLES.length} ` +
    'tables the PostgreSQL backends own gained inserts in a real database during this run. ' +
    'This does not attribute those inserts to the built PgDocumentStore / PgRuntimeStore ' +
    'specifically — see the threat model at the top of this script.',
);
