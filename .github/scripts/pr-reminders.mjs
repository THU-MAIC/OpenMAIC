// Daily reminders for open pull requests whose CI cannot run:
//
// - conflict: the pull request conflicts with its base branch. GitHub does not
//   start `pull_request` workflows for it, so pushes go unchecked and the
//   author is often unaware.
// - approval: workflow runs for the head commit wait in `action_required`
//   until a maintainer approves them (first-time fork contributors).
//
// Each reminder is a single comment identified by a hidden marker. Later runs
// update that comment in place (no new notification) instead of reposting.
//
// The module is used by .github/workflows/pr-reminders.yml through
// actions/github-script. It can also be run locally, always as a dry run:
//   GITHUB_TOKEN=$(gh auth token) node .github/scripts/pr-reminders.mjs
import { pathToFileURL } from 'node:url';

export const MARKERS = {
  conflict: '<!-- openmaic-pr-reminder:conflict -->',
  approval: '<!-- openmaic-pr-reminder:approval -->',
};
export const STALE_MS = 24 * 60 * 60 * 1000;
export const MAX_WRITES_PER_RUN = 20;
const BOT_LOGIN = 'github-actions[bot]';
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export function isDryRun(eventName, dryRunInput, mode) {
  if (eventName === 'workflow_dispatch') return dryRunInput !== 'false' && dryRunInput !== false;
  return mode !== 'apply';
}

// Last matching line wins, as in GitHub's own CODEOWNERS resolution.
export function globalOwners(text) {
  let owners = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    if (pattern === '*' || pattern === '/*' || pattern === '**' || pattern === '/**') {
      owners = rest.filter((owner) => /^@[\w.-]+(\/[\w.-]+)?$/.test(owner));
    }
  }
  return owners;
}

export function isEligible(pr) {
  return !pr.isDraft && pr.author?.__typename !== 'Bot';
}

function time(value) {
  return value ? Date.parse(value) : 0;
}

// GitHub records no timestamp for when a pull request became conflicting.
// Workflows cannot start while it conflicts, so the latest workflow run for its
// head branch (or its creation, if none ever ran) bounds how long CI has been
// blocked.
export function conflictSince(pr, runs) {
  const head = pr.headRepository?.nameWithOwner;
  const latest = runs
    .filter(
      (run) =>
        run.event === 'pull_request' &&
        run.head_branch === pr.headRefName &&
        run.head_repository?.full_name === head,
    )
    .reduce((max, run) => Math.max(max, time(run.created_at)), 0);
  return new Date(Math.max(time(pr.createdAt), latest)).toISOString();
}

// Oldest `action_required` run on the current head commit, or null.
export function approvalSince(pr, runsBySha) {
  const runs = runsBySha.get(pr.headRefOid) ?? [];
  if (!runs.length) return null;
  return new Date(Math.min(...runs.map((run) => time(run.created_at)))).toISOString();
}

export function isStale(since, now, threshold = STALE_MS) {
  return since !== null && now - time(since) > threshold;
}

export function groupRunsBySha(runs) {
  const map = new Map();
  for (const run of runs) {
    if (run.status !== 'action_required' && run.conclusion !== 'action_required') continue;
    if (!map.has(run.head_sha)) map.set(run.head_sha, []);
    map.get(run.head_sha).push(run);
  }
  return map;
}

export function conflictBody(pr, base) {
  return [
    MARKERS.conflict,
    `Hi @${pr.author.login}, this pull request has merge conflicts with \`${base}\` and CI has not been able to run on it for over a day.`,
    '',
    'GitHub does not start `pull_request` workflows while a pull request has conflicts, so recent pushes have not been checked. Please merge or rebase onto the latest `' +
      base +
      '` and resolve the conflicts; CI runs again on the next push.',
    '',
    'If this pull request is still a work in progress, converting it to a draft stops this reminder. If it is no longer needed, feel free to close it.',
    '',
    '<sub>Automated reminder. It is posted once and updated in place.</sub>',
    '',
  ].join('\n');
}

export function approvalBody(pr, runs, owners) {
  const names = [...new Set(runs.map((run) => run.name))].sort();
  const who = owners.length ? `${owners.join(' ')}: a maintainer` : 'A maintainer';
  return [
    MARKERS.approval,
    `Workflow runs for the latest commit of this pull request have been waiting for maintainer approval for over a day, so CI has not run yet.`,
    '',
    `${who} with write access should review the changes and, if they are safe to run, approve the pending workflows ("Approve and run workflows" on this pull request).`,
    '',
    `Waiting: ${names.map((name) => `\`${name}\``).join(', ')}.`,
    '',
    `@${pr.author.login}, nothing is needed from you for this step.`,
    '',
    '<sub>Automated reminder. It is posted once and updated in place.</sub>',
    '',
  ].join('\n');
}

// Pure decision for one pull request. A conflicting pull request only gets the
// conflict reminder: approval alone would not let its CI run. Unknown
// mergeability is left for the next run rather than guessed.
export function decide(pr, { now, branchRuns, runsBySha, owners, base }) {
  if (!isEligible(pr) || pr.mergeable === 'UNKNOWN') return null;
  if (pr.mergeable === 'CONFLICTING') {
    const since = conflictSince(pr, branchRuns ?? []);
    if (!isStale(since, now)) return null;
    return { kind: 'conflict', since, body: conflictBody(pr, base ?? pr.baseRefName) };
  }
  const since = approvalSince(pr, runsBySha);
  if (!isStale(since, now)) return null;
  return {
    kind: 'approval',
    since,
    body: approvalBody(pr, runsBySha.get(pr.headRefOid), owners),
  };
}

export function findReminder(comments, kind) {
  return (
    comments.find(
      (comment) =>
        comment.user?.login === BOT_LOGIN &&
        comment.user?.type === 'Bot' &&
        comment.body?.startsWith(MARKERS[kind]),
    ) ?? null
  );
}

// ---- GitHub access (an octokit-compatible `request` / `graphql` client) ----

const PR_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url isDraft mergeable createdAt baseRefName headRefName headRefOid
        headRepository { nameWithOwner }
        author { login __typename }
      }
    }
  }
}`;

async function queryOpenPullRequests(client, repo, maxPages) {
  const prs = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.graphql(PR_QUERY, { ...repo, cursor });
    const { nodes, pageInfo } = data.repository.pullRequests;
    prs.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return prs;
}

// `mergeable` is computed lazily: the first query starts the computation and
// may report UNKNOWN. Re-query a few times; anything still UNKNOWN is skipped
// until the next run.
export async function listOpenPullRequests(
  client,
  repo,
  { sleep = defaultSleep, attempts = 3, maxPages = 5 } = {},
) {
  let prs = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    prs = await queryOpenPullRequests(client, repo, maxPages);
    if (!prs.some((pr) => isEligible(pr) && pr.mergeable === 'UNKNOWN')) break;
    if (attempt < attempts) await sleep(5000 * attempt);
  }
  return prs;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paginate(client, route, params, pick, maxPages) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await client.request(route, { ...params, per_page: 100, page });
    const batch = pick(data);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export async function readGlobalOwners(client, repo) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const { data } = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
        ...repo,
        path,
      });
      return globalOwners(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return [];
}

export async function run({ client, repo, now = Date.now(), dryRun = true, log = console.log }) {
  const [prs, pending, owners, repoInfo] = await Promise.all([
    listOpenPullRequests(client, repo),
    paginate(
      client,
      'GET /repos/{owner}/{repo}/actions/runs',
      { ...repo, status: 'action_required' },
      (data) => data.workflow_runs,
      5,
    ),
    readGlobalOwners(client, repo),
    client.request('GET /repos/{owner}/{repo}', repo),
  ]);
  const runsBySha = groupRunsBySha(pending);
  const defaultBranch = repoInfo.data.default_branch;
  const results = [];
  let writes = 0;

  for (const pr of prs) {
    if (!isEligible(pr)) continue;
    let branchRuns = [];
    if (pr.mergeable === 'CONFLICTING') {
      branchRuns = await paginate(
        client,
        'GET /repos/{owner}/{repo}/actions/runs',
        { ...repo, branch: pr.headRefName, event: 'pull_request' },
        (data) => data.workflow_runs,
        1,
      );
    }
    const decision = decide(pr, {
      now,
      branchRuns,
      runsBySha,
      owners,
      base: pr.baseRefName || defaultBranch,
    });
    if (!decision) continue;

    const comments = await paginate(
      client,
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...repo, issue_number: pr.number },
      (data) => data,
      10,
    );
    const existing = findReminder(comments, decision.kind);
    let action;
    if (existing && existing.body === decision.body) action = 'unchanged';
    else if (existing) action = 'update';
    else action = 'create';

    if (!dryRun && action !== 'unchanged') {
      if (writes >= MAX_WRITES_PER_RUN) {
        action = 'deferred';
      } else if (action === 'update') {
        await client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          ...repo,
          comment_id: existing.id,
          body: decision.body,
        });
        writes++;
      } else {
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          ...repo,
          issue_number: pr.number,
          body: decision.body,
        });
        writes++;
      }
    }
    const result = {
      number: pr.number,
      url: pr.url,
      kind: decision.kind,
      since: decision.since,
      action,
    };
    results.push(result);
    log(
      `#${pr.number} ${decision.kind} since ${decision.since}: ${dryRun ? 'would ' : ''}${action}`,
    );
  }
  return { dryRun, owners, scanned: prs.length, results };
}

export function summaryMarkdown({ dryRun, owners, scanned, results }) {
  const lines = [
    `## Stuck pull request reminders${dryRun ? ' (dry run)' : ''}`,
    '',
    `Scanned ${scanned} open pull requests. Global code owners: ${owners.length ? owners.join(' ') : '(none)'}.`,
    '',
    'For conflicts, "stuck since" is the last `pull_request` workflow run (or the creation time): GitHub records no time for when a conflict appeared.',
    '',
  ];
  if (!results.length) return [...lines, 'Nothing is stuck.', ''].join('\n');
  lines.push('| Pull request | Reason | Stuck since | Comment |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const reason = r.kind === 'conflict' ? 'merge conflict' : 'workflow approval';
    const action = dryRun && r.action !== 'unchanged' ? `would ${r.action}` : r.action;
    lines.push(`| [#${r.number}](${r.url}) | ${reason} | ${r.since} | ${action} |`);
  }
  return [...lines, ''].join('\n');
}

// Minimal octokit-compatible client for local dry runs.
export function fetchClient(token, baseUrl = 'https://api.github.com') {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  return {
    async request(route, params = {}) {
      const [method, template] = route.split(' ');
      if (method !== 'GET') throw new Error(`Local runs are read-only: refused ${route}`);
      const rest = { ...params };
      const path = template.replace(/\{(\w+)\}/g, (_, key) => {
        const value = rest[key];
        delete rest[key];
        return key === 'path' ? String(value) : encodeURIComponent(value);
      });
      const url = new URL(baseUrl + path);
      for (const [key, value] of Object.entries(rest)) url.searchParams.set(key, String(value));
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const error = new Error(`${route} -> ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const type = response.headers.get('content-type') ?? '';
      return { data: type.includes('json') ? await response.json() : await response.text() };
    },
    async graphql(query, variables) {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors));
      return body.data;
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
  console.log('\n' + summaryMarkdown(result));
}
