// Weekly report of flaky CI: workflow attempts that failed and then passed on
// the same code without a change.
//
// A failed attempt counts as flaky when either
// - a later attempt of the same run succeeded (a re-run), or
// - a later run of the same workflow, event and head commit succeeded.
//
// For each such attempt the report lists the failed jobs and steps, and, where
// the job log contains Vitest output, the failing test files and test names.
//
// The module is used by .github/workflows/flaky-report.yml through
// actions/github-script. It can also be run locally, always as a dry run:
//   GITHUB_TOKEN=$(gh auth token) node .github/scripts/flaky-report.mjs
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- openmaic-flaky-report:v1 -->';
export const LABEL = 'flaky-report';
export const TITLE = 'Flaky CI report';
export const WINDOW_DAYS = 7;
export const MAX_LOGS = 40;
const MAX_BODY = 60000;
const DAY = 24 * 60 * 60 * 1000;
const FAILED = new Set(['failure', 'timed_out']);
const BOT_LOGIN = 'github-actions[bot]';

export function isDryRun(eventName, dryRunInput) {
  if (eventName === 'workflow_dispatch') return dryRunInput !== 'false' && dryRunInput !== false;
  return false;
}

// UTC calendar days overlapping [now - days, now], oldest first. The runs API
// returns at most 1,000 runs per query, so the window is queried day by day.
export function windowDays(now, days = WINDOW_DAYS) {
  const result = [];
  const start = new Date(now - days * DAY);
  start.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= now; t += DAY) {
    result.push(new Date(t).toISOString().slice(0, 10));
  }
  return result;
}

const time = (value) => Date.parse(value);

// Pure: which (run, attempt) pairs to inspect. Whether an attempt really
// failed is decided later from its jobs, because the runs list only carries
// the latest attempt's conclusion.
export function findCandidates(runs) {
  const completed = runs.filter((run) => run.status === 'completed');
  const candidates = [];
  for (const run of completed) {
    if (run.conclusion !== 'success' || run.run_attempt < 2) continue;
    for (let attempt = 1; attempt < run.run_attempt; attempt++) {
      candidates.push({ run, attempt, recovery: 'rerun', recoveredBy: run });
    }
  }

  const groups = new Map();
  for (const run of completed) {
    const key = `${run.workflow_id}|${run.event}|${run.head_sha}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  for (const group of groups.values()) {
    for (const run of group) {
      if (!FAILED.has(run.conclusion)) continue;
      const recoveredBy = group
        .filter(
          (other) =>
            other.conclusion === 'success' && time(other.created_at) > time(run.created_at),
        )
        .sort((a, b) => time(a.created_at) - time(b.created_at))[0];
      if (recoveredBy) {
        candidates.push({ run, attempt: run.run_attempt, recovery: 'new run', recoveredBy });
      }
    }
  }
  return candidates;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const VITEST_FAIL =
  /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+\[[^\]]*\])?(?:\s+>\s+(.+?))?\s*$/;

// Vitest prints one `FAIL <file> > <suite> > <test>` line per failed test (or
// per failed file, without a test name) in its failure summary.
export function extractTestFailures(log) {
  const seen = new Map();
  for (const raw of String(log ?? '').split('\n')) {
    const line = raw.replace(TIMESTAMP, '').replace(ANSI, '');
    const match = VITEST_FAIL.exec(line);
    if (!match) continue;
    const file = match[1];
    const name = match[2]?.replace(/\s+/g, ' ') ?? null;
    seen.set(`${file}\u0000${name}`, { file, name });
  }
  return [...seen.values()];
}

export function failedJobs(jobs) {
  return jobs
    .filter((job) => FAILED.has(job.conclusion))
    .map((job) => ({
      id: job.id,
      name: job.name,
      url: job.html_url,
      steps: (job.steps ?? []).filter((step) => FAILED.has(step.conclusion)).map((s) => s.name),
    }));
}

export function aggregate(records) {
  const jobs = new Map();
  const tests = new Map();
  for (const record of records) {
    const jobKey = `${record.workflow}\u0000${record.job}`;
    if (!jobs.has(jobKey)) {
      jobs.set(jobKey, {
        workflow: record.workflow,
        job: record.job,
        count: 0,
        shas: new Set(),
        steps: new Map(),
        withTests: 0,
      });
    }
    const job = jobs.get(jobKey);
    job.count++;
    job.shas.add(record.sha);
    for (const step of record.steps.length ? record.steps : ['(no failed step reported)']) {
      job.steps.set(step, (job.steps.get(step) ?? 0) + 1);
    }
    if (record.tests?.length) job.withTests++;

    for (const t of record.tests ?? []) {
      const key = `${t.file}\u0000${t.name}`;
      if (!tests.has(key)) tests.set(key, { ...t, count: 0, shas: new Set(), examples: [] });
      const entry = tests.get(key);
      entry.count++;
      entry.shas.add(record.sha);
      if (entry.examples.length < 3) entry.examples.push(record.url);
    }
  }
  const byCount = (a, b) =>
    b.count - a.count || `${a.workflow ?? a.file}`.localeCompare(`${b.workflow ?? b.file}`);
  return { jobs: [...jobs.values()].sort(byCount), tests: [...tests.values()].sort(byCount) };
}

const cell = (value) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
const short = (sha) => String(sha).slice(0, 7);

export function renderReport({ from, to, scanned, truncatedDays, records, logsSkipped }) {
  const { jobs, tests } = aggregate(records);
  const commits = new Set(records.map((r) => r.sha)).size;
  const lines = [
    MARKER,
    `# ${TITLE}`,
    '',
    `Window: ${from} to ${to} (UTC), updated weekly. Scanned ${scanned} workflow runs.`,
    '',
    records.length
      ? `**${records.length} failed job${records.length === 1 ? '' : 's'}** on ${commits} commit${commits === 1 ? '' : 's'} passed when re-run or when the same workflow ran again on the same commit.`
      : 'No flaky failures found in this window.',
    '',
  ];
  if (truncatedDays.length) {
    lines.push(
      `> Warning: the runs API capped results for ${truncatedDays.join(', ')}; some runs were not scanned.`,
      '',
    );
  }
  if (jobs.length) {
    lines.push(
      '## By job',
      '',
      '| Workflow | Job | Flaky failures | Commits | Failed steps |',
      '| --- | --- | ---: | ---: | --- |',
    );
    for (const job of jobs) {
      const steps = [...job.steps]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${cell(name)} (${count})`)
        .join(', ');
      lines.push(
        `| ${cell(job.workflow)} | ${cell(job.job)} | ${job.count} | ${job.shas.size} | ${steps} |`,
      );
    }
    lines.push('');
  }
  if (tests.length) {
    lines.push(
      '## By test',
      '',
      'From Vitest output in the failed job logs.',
      '',
      '| Test file | Test | Failures | Examples |',
      '| --- | --- | ---: | --- |',
    );
    for (const t of tests.slice(0, 50)) {
      const examples = t.examples.map((url, i) => `[${i + 1}](${url})`).join(' ');
      lines.push(
        `| \`${cell(t.file)}\` | ${cell(t.name ?? '(whole file)')} | ${t.count} | ${examples} |`,
      );
    }
    if (tests.length > 50) lines.push('', `${tests.length - 50} more tests not shown.`);
    lines.push('');
  }
  if (records.length) {
    lines.push('## Failed attempts', '');
    const sorted = [...records].sort((a, b) => time(b.created_at) - time(a.created_at));
    for (const r of sorted) {
      const tested =
        r.tests === null ? '' : r.tests.length ? `: ${r.tests.length} failing test(s)` : '';
      lines.push(
        `- [${cell(r.workflow)} / ${cell(r.job)}](${r.url}) attempt ${r.attempt} on \`${short(r.sha)}\` (${r.event}), passed on ${r.recovery}${tested}`,
      );
    }
    lines.push('');
  }
  const notes = [
    '<sub>Generated by the weekly flaky CI report workflow. A `new run` recovery on a `pull_request` event may test a different merge commit if the base branch moved.',
  ];
  if (logsSkipped)
    notes.push(` Test names were not extracted for ${logsSkipped} job(s) (log limit).`);
  notes.push('</sub>');
  lines.push(notes.join(''), '');

  let body = lines.join('\n');
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n\n_Report truncated to fit the issue size limit; see the workflow job summary._\n`;
  }
  return body;
}

// ---- GitHub access (an octokit-compatible `request` client) ----

async function paginate(client, route, params, pick, maxPages) {
  const items = [];
  let capped = true;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await client.request(route, { ...params, per_page: 100, page });
    const batch = pick(data);
    items.push(...batch);
    if (batch.length < 100) {
      capped = false;
      break;
    }
  }
  return { items, capped };
}

export async function collectRecords(client, repo, { now = Date.now(), days = WINDOW_DAYS } = {}) {
  const since = now - days * DAY;
  const byId = new Map();
  const truncatedDays = [];
  for (const day of windowDays(now, days)) {
    const { items, capped } = await paginate(
      client,
      'GET /repos/{owner}/{repo}/actions/runs',
      { ...repo, created: day, exclude_pull_requests: true },
      (data) => data.workflow_runs,
      10,
    );
    if (capped) truncatedDays.push(day);
    for (const run of items) if (time(run.created_at) >= since) byId.set(run.id, run);
  }
  const runs = [...byId.values()];

  const records = [];
  for (const candidate of findCandidates(runs)) {
    const { run, attempt } = candidate;
    const { items } = await paginate(
      client,
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
      { ...repo, run_id: run.id, attempt_number: attempt },
      (data) => data.jobs,
      3,
    );
    for (const job of failedJobs(items)) {
      records.push({
        workflow: run.name,
        job: job.name,
        jobId: job.id,
        steps: job.steps,
        url: job.url,
        attempt,
        sha: run.head_sha,
        event: run.event,
        created_at: run.created_at,
        recovery: candidate.recovery,
        tests: null,
      });
    }
  }
  return {
    from: new Date(since).toISOString().slice(0, 16).replace('T', ' '),
    to: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
    scanned: runs.length,
    truncatedDays,
    records,
  };
}

export async function addTestNames(
  client,
  repo,
  records,
  { maxLogs = MAX_LOGS, log = () => {} } = {},
) {
  let fetched = 0;
  let skipped = 0;
  for (const record of records) {
    if (fetched >= maxLogs) {
      skipped++;
      continue;
    }
    fetched++;
    try {
      const { data } = await client.request(
        'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
        {
          ...repo,
          job_id: record.jobId,
        },
      );
      record.tests = extractTestFailures(
        typeof data === 'string' ? data : Buffer.from(data).toString(),
      );
    } catch (error) {
      // Expired or unavailable logs: keep the job/step level record.
      log(`Could not read logs for job ${record.jobId}: ${error.status ?? error.message}`);
    }
  }
  return skipped;
}

export async function upsertIssue(client, repo, body) {
  try {
    await client.request('GET /repos/{owner}/{repo}/labels/{name}', { ...repo, name: LABEL });
  } catch (error) {
    if (error.status !== 404) throw error;
    await client.request('POST /repos/{owner}/{repo}/labels', {
      ...repo,
      name: LABEL,
      color: 'c5def5',
      description: 'Weekly flaky CI report',
    });
  }
  const { items } = await paginate(
    client,
    'GET /repos/{owner}/{repo}/issues',
    { ...repo, labels: LABEL, state: 'open', creator: BOT_LOGIN },
    (data) => data,
    1,
  );
  const existing = items.find((issue) => !issue.pull_request && issue.body?.startsWith(MARKER));
  if (existing) {
    await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repo,
      issue_number: existing.number,
      title: TITLE,
      body,
    });
    return { action: 'updated', number: existing.number, url: existing.html_url };
  }
  const { data } = await client.request('POST /repos/{owner}/{repo}/issues', {
    ...repo,
    title: TITLE,
    body,
    labels: [LABEL],
  });
  return { action: 'created', number: data.number, url: data.html_url };
}

export async function run({ client, repo, now = Date.now(), dryRun = true, log = console.log }) {
  const collected = await collectRecords(client, repo, { now });
  log(`Scanned ${collected.scanned} runs; ${collected.records.length} flaky failed job(s).`);
  const logsSkipped = await addTestNames(client, repo, collected.records, { log });
  const body = renderReport({ ...collected, logsSkipped });
  const issue = dryRun ? null : await upsertIssue(client, repo, body);
  return { ...collected, body, issue };
}

// Minimal octokit-compatible client for local dry runs.
export function fetchClient(token, baseUrl = 'https://api.github.com') {
  return {
    async request(route, params = {}) {
      const [method, template] = route.split(' ');
      if (method !== 'GET') throw new Error(`Local runs are read-only: refused ${route}`);
      const rest = { ...params };
      const path = template.replace(/\{(\w+)\}/g, (_, key) => {
        const value = rest[key];
        delete rest[key];
        return encodeURIComponent(value);
      });
      const url = new URL(baseUrl + path);
      for (const [key, value] of Object.entries(rest)) url.searchParams.set(key, String(value));
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) {
        const error = new Error(`${route} -> ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const type = response.headers.get('content-type') ?? '';
      return { data: type.includes('json') ? await response.json() : await response.text() };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (for example: GITHUB_TOKEN=$(gh auth token)).');
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? 'THU-MAIC/OpenMAIC').split('/');
  const result = await run({
    client: fetchClient(token),
    repo: { owner, repo: name },
    dryRun: true,
  });
  console.log('\n' + result.body);
}
