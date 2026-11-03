import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LABEL,
  MARKER,
  MAX_LOGS,
  TITLE,
  addTestNames,
  aggregate,
  extractTestFailures,
  failedJobs,
  fetchClient,
  findCandidates,
  isDryRun,
  renderReport,
  run,
  upsertIssue,
  windowDays,
} from './flaky-report.mjs';

const repo = { owner: 'THU-MAIC', repo: 'OpenMAIC' };
const NOW = Date.parse('2026-10-27T09:00:00Z');

const makeRun = (id, extras = {}) => ({
  id,
  name: 'CI',
  workflow_id: 1,
  event: 'pull_request',
  head_sha: `sha${id}`,
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: '2026-10-25T00:00:00Z',
  ...extras,
});
const makeJob = (id, conclusion, steps = [], extras = {}) => ({
  id,
  name: 'Lint, Typecheck & Unit Tests',
  conclusion,
  html_url: `https://github.com/THU-MAIC/OpenMAIC/actions/runs/1/job/${id}`,
  steps: steps.map(([name, stepConclusion]) => ({ name, conclusion: stepConclusion })),
  ...extras,
});

// Trimmed from a real Vitest failure summary in an Actions job log.
const ESC = '\x1b';
const VITEST_LOG = [
  `2026-10-27T07:24:13.5853399Z ${ESC}[31m       ${ESC}[31m×${ESC}[31m a publication waits for it${ESC}[39m${ESC}[33m 5689${ESC}[2mms${ESC}[22m${ESC}[39m`,
  `2026-10-27T07:24:13.8921649Z ${ESC}[31m⎯⎯⎯⎯⎯⎯⎯${ESC}[39m${ESC}[1m${ESC}[41m Failed Tests 2 ${ESC}[49m${ESC}[22m${ESC}[31m⎯⎯⎯⎯⎯⎯⎯${ESC}[39m`,
  `2026-10-27T07:24:13.8926455Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m tests/persistence/owner.pg.test.ts${ESC}[2m > ${ESC}[22mowner on PostgreSQL${ESC}[2m > ${ESC}[22mraces${ESC}[2m > ${ESC}[22ma publication waits for it`,
  `2026-10-27T07:24:13.8926455Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m tests/persistence/owner.pg.test.ts${ESC}[2m > ${ESC}[22mowner on PostgreSQL${ESC}[2m > ${ESC}[22mraces${ESC}[2m > ${ESC}[22ma publication waits for it`,
  `2026-10-27T07:24:13.9000000Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m |storage| src/broken.spec.tsx [ src/broken.spec.tsx ]`,
  '2026-10-27T07:24:13.9036241Z  Test Files  1 failed | 28 passed (29)',
  '2026-10-27T07:24:14.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

test('dry run defaults on for manual runs and off for the schedule', () => {
  assert.equal(isDryRun('workflow_dispatch', 'true'), true);
  assert.equal(isDryRun('workflow_dispatch', ''), true);
  assert.equal(isDryRun('workflow_dispatch', 'false'), false);
  assert.equal(isDryRun('schedule', ''), false);
});

test('the window is queried by UTC day, covering the partial first day', () => {
  assert.deepEqual(windowDays(NOW, 7), [
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
  ]);
});

test('candidates are earlier attempts of re-run successes and failures fixed by a later run', () => {
  const runs = [
    makeRun(1, { run_attempt: 3 }),
    makeRun(2, { run_attempt: 2, conclusion: 'failure' }),
    makeRun(3, { head_sha: 'same', conclusion: 'failure', created_at: '2026-10-25T01:00:00Z' }),
    makeRun(4, { head_sha: 'same', created_at: '2026-10-25T02:00:00Z' }),
    // A success before the failure does not recover it.
    makeRun(5, { head_sha: 'early', created_at: '2026-10-25T01:00:00Z' }),
    makeRun(6, { head_sha: 'early', conclusion: 'failure', created_at: '2026-10-25T02:00:00Z' }),
    // Different workflow or event on the same commit does not count.
    makeRun(7, { head_sha: 'mixed', conclusion: 'failure', created_at: '2026-10-25T01:00:00Z' }),
    makeRun(8, { head_sha: 'mixed', workflow_id: 2, created_at: '2026-10-25T02:00:00Z' }),
    makeRun(9, { head_sha: 'mixed', event: 'push', created_at: '2026-10-25T02:00:00Z' }),
    // Cancelled and still-running runs are not flaky.
    makeRun(10, { head_sha: 'c', conclusion: 'cancelled', created_at: '2026-10-25T01:00:00Z' }),
    makeRun(11, { head_sha: 'c', created_at: '2026-10-25T02:00:00Z' }),
    makeRun(12, { run_attempt: 2, status: 'in_progress', conclusion: null }),
  ];
  assert.deepEqual(
    findCandidates(runs).map((c) => [c.run.id, c.attempt, c.recovery, c.recoveredBy.id]),
    [
      [1, 1, 'rerun', 1],
      [1, 2, 'rerun', 1],
      [3, 1, 'new run', 4],
    ],
  );
});

test('Vitest failures are read from colored, timestamped logs and deduplicated', () => {
  assert.deepEqual(extractTestFailures(VITEST_LOG), [
    {
      file: 'tests/persistence/owner.pg.test.ts',
      name: 'owner on PostgreSQL > races > a publication waits for it',
    },
    { file: 'src/broken.spec.tsx', name: null },
  ]);
  assert.deepEqual(extractTestFailures('FAIL something else\n'), []);
  assert.deepEqual(extractTestFailures(undefined), []);
});

test('failed jobs keep only failed or timed out jobs and steps', () => {
  const jobs = failedJobs([
    makeJob(1, 'success'),
    makeJob(2, 'failure', [
      ['Checkout', 'success'],
      ['Unit Tests', 'failure'],
    ]),
    makeJob(3, 'timed_out', [['Contracts', 'cancelled']]),
    makeJob(4, 'cancelled'),
  ]);
  assert.deepEqual(
    jobs.map((j) => [j.id, j.steps]),
    [
      [2, ['Unit Tests']],
      [3, []],
    ],
  );
});

const record = (extras = {}) => ({
  workflow: 'CI',
  job: 'Lint, Typecheck & Unit Tests',
  jobId: 1,
  steps: ['Unit Tests'],
  url: 'https://example.test/job/1',
  attempt: 1,
  sha: 'aaaaaaaaaa',
  event: 'pull_request',
  created_at: '2026-10-25T00:00:00Z',
  recovery: 'rerun',
  tests: [{ file: 'tests/a.test.ts', name: 'suite > flaky one' }],
  ...extras,
});

test('aggregation ranks jobs and tests by failure count', () => {
  const { jobs, tests } = aggregate([
    record(),
    record({ sha: 'bbbbbbbbbb', url: 'https://example.test/job/2' }),
    record({
      workflow: 'Storage PostgreSQL Contract',
      job: 'Storage Contract (PostgreSQL 16)',
      steps: [],
      tests: null,
    }),
  ]);
  assert.deepEqual(
    jobs.map((j) => [j.workflow, j.count, j.shas.size, [...j.steps.keys()]]),
    [
      ['CI', 2, 2, ['Unit Tests']],
      ['Storage PostgreSQL Contract', 1, 1, ['(no failed step reported)']],
    ],
  );
  assert.equal(tests.length, 1);
  assert.equal(tests[0].count, 2);
  assert.deepEqual(tests[0].examples, ['https://example.test/job/1', 'https://example.test/job/2']);
});

test('the report starts with the marker and escapes table cells', () => {
  const body = renderReport({
    from: '2026-10-20 09:00',
    to: '2026-10-27 09:00',
    scanned: 120,
    truncatedDays: ['2026-10-22'],
    records: [record({ tests: [{ file: 'tests/a.test.ts', name: 'pipes | in name' }] })],
    logsSkipped: 2,
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\*\*1 failed job\*\* on 1 commit passed/);
  assert.match(body, /capped results for 2026-10-22/);
  assert.match(body, /\| CI \| Lint, Typecheck & Unit Tests \| 1 \| 1 \| Unit Tests \(1\) \|/);
  assert.match(body, /pipes \\\| in name/);
  assert.match(body, /attempt 1 on `aaaaaaa` \(pull_request\), passed on rerun: 1 failing test/);
  assert.match(body, /not extracted for 2 job/);

  const empty = renderReport({
    from: 'a',
    to: 'b',
    scanned: 0,
    truncatedDays: [],
    records: [],
    logsSkipped: 0,
  });
  assert.match(empty, /No flaky failures found/);
  assert.doesNotMatch(empty, /## By job/);
});

test('oversized reports are truncated below the issue body limit', () => {
  const records = Array.from({ length: 800 }, (_, i) =>
    record({ job: `job ${i} ${'x'.repeat(60)}`, url: `https://example.test/job/${i}` }),
  );
  const body = renderReport({
    from: 'a',
    to: 'b',
    scanned: 800,
    truncatedDays: [],
    records,
    logsSkipped: 0,
  });
  assert.ok(body.length < 65536);
  assert.match(body, /Report truncated/);
});

function fakeClient({ runsByDay = {}, jobs = {}, logs = {}, issues = [], label = true }) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    async request(route, params) {
      reads.push(route);
      if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
        const all = runsByDay[params.created] ?? [];
        return { data: { workflow_runs: all.slice((params.page - 1) * 100, params.page * 100) } };
      }
      if (
        route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs'
      ) {
        return { data: { jobs: jobs[`${params.run_id}/${params.attempt_number}`] ?? [] } };
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs') {
        if (!(params.job_id in logs)) throw Object.assign(new Error('Gone'), { status: 410 });
        return { data: logs[params.job_id] };
      }
      if (route === 'GET /repos/{owner}/{repo}/labels/{name}') {
        if (!label) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { name: LABEL } };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues') return { data: issues };
      writes.push({ route, params });
      return { data: { number: 77, html_url: 'https://example.test/issues/77' } };
    },
  };
}

test('run collects flaky jobs with test names and never writes in a dry run', async () => {
  const client = fakeClient({
    runsByDay: {
      '2026-10-25': [makeRun(1, { run_attempt: 2 }), makeRun(2)],
      // Outside the exact window although on a queried day.
      '2026-10-20': [makeRun(3, { run_attempt: 2, created_at: '2026-10-20T01:00:00Z' })],
    },
    jobs: {
      '1/1': [
        makeJob(11, 'failure', [['Unit Tests', 'failure']]),
        makeJob(12, 'failure', [['Contracts', 'failure']], { name: 'Other' }),
        makeJob(13, 'success'),
      ],
      '3/1': [makeJob(31, 'failure')],
    },
    logs: { 11: VITEST_LOG },
  });
  const result = await run({ client, repo, now: NOW, dryRun: true, log: () => {} });
  assert.equal(result.scanned, 2);
  assert.deepEqual(
    result.records.map((r) => [r.jobId, r.steps, r.tests?.length ?? null]),
    [
      [11, ['Unit Tests'], 2],
      [12, ['Contracts'], null],
    ],
  );
  assert.equal(result.issue, null);
  assert.equal(client.writes.length, 0);
  assert.ok(result.body.startsWith(MARKER));
});

test('the runs query is flagged as truncated when a day hits the API cap', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => makeRun(1000 + i, { conclusion: 'failure' }));
  const client = fakeClient({ runsByDay: { '2026-10-25': many } });
  const result = await run({ client, repo, now: NOW, dryRun: true, log: () => {} });
  assert.deepEqual(result.truncatedDays, ['2026-10-25']);
});

test('log downloads are capped', async () => {
  const records = Array.from({ length: MAX_LOGS + 5 }, (_, i) => record({ jobId: i, tests: null }));
  const client = fakeClient({});
  const skipped = await addTestNames(client, repo, records);
  assert.equal(skipped, 5);
  assert.equal(client.reads.length, MAX_LOGS);
});

test('the tracking issue is updated in place, or created with its label', async () => {
  const ours = {
    number: 5,
    html_url: 'https://example.test/issues/5',
    body: `${MARKER}\nold`,
  };
  const foreign = { number: 6, body: 'a person wrote this' };
  const update = fakeClient({ issues: [foreign, ours] });
  assert.deepEqual(await upsertIssue(update, repo, 'new body'), {
    action: 'updated',
    number: 5,
    url: 'https://example.test/issues/5',
  });
  assert.deepEqual(update.writes, [
    {
      route: 'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
      params: { ...repo, issue_number: 5, title: TITLE, body: 'new body' },
    },
  ]);

  const create = fakeClient({ issues: [foreign], label: false });
  const created = await upsertIssue(create, repo, 'first body');
  assert.equal(created.action, 'created');
  assert.deepEqual(
    create.writes.map((w) => w.route),
    ['POST /repos/{owner}/{repo}/labels', 'POST /repos/{owner}/{repo}/issues'],
  );
  assert.deepEqual(create.writes[1].params.labels, [LABEL]);
});

test('the local client refuses writes', async () => {
  const client = fetchClient('token', 'http://127.0.0.1:9');
  await assert.rejects(client.request('POST /repos/{owner}/{repo}/issues', repo), /read-only/);
});
