// Daily reminders for open pull requests that are stuck:
//
// - conflict: the pull request conflicts with its base branch. GitHub does not
//   start `pull_request` workflows for it, so pushes go unchecked and the
//   author is often unaware.
// - approval: workflow runs for the head commit wait in `action_required`
//   until a maintainer approves them (first-time fork contributors).
// - codex: Codex review threads stay unresolved for over a day. Maintainers
//   review a pull request once every Codex thread has a reply and is resolved.
//   If the author shows no activity (push, comment, review or thread reply)
//   for CODEX_CLOSE_MS after the reminder, the pull request is closed with a
//   comment saying it can be reopened once the threads are addressed. Pull
//   requests labelled `status:blocked` are exempt (the ball is with the
//   maintainers).
//
// Drafts and bot-authored pull requests are never reminded or closed.
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
  codex: '<!-- openmaic-pr-reminder:codex -->',
  codexClosed: '<!-- openmaic-pr-reminder:codex-closed -->',
};
export const STALE_MS = 24 * 60 * 60 * 1000;
export const CODEX_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;
export const BLOCKED_LABEL = 'status:blocked';
const CODEX_LOGIN_PREFIX = 'chatgpt-codex-connector';
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
  // A deleted author account comes back as `author: null`: nobody to remind.
  return !pr.isDraft && Boolean(pr.author?.login) && pr.author.__typename !== 'Bot';
}

export function isBlocked(pr) {
  return (pr.labels?.nodes ?? []).some((label) => label.name === BLOCKED_LABEL);
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

// Unresolved review threads opened by Codex. Outdated threads still count:
// the author is expected to reply and resolve them.
export function unresolvedCodexThreads(pr) {
  return (pr.reviewThreads?.nodes ?? []).filter((thread) => {
    const first = thread.comments?.nodes?.[0];
    return !thread.isResolved && first?.author?.login?.startsWith(CODEX_LOGIN_PREFIX);
  });
}

// Oldest unresolved Codex thread, or null.
export function codexSince(pr) {
  const threads = unresolvedCodexThreads(pr);
  if (!threads.length) return null;
  return new Date(
    Math.min(...threads.map((thread) => time(thread.comments.nodes[0].createdAt))),
  ).toISOString();
}

function threadCount(count) {
  return count === 1 ? '1 Codex review thread is' : `${count} Codex review threads are`;
}

export function codexBody(pr, count) {
  return [
    MARKERS.codex,
    `Hi @${pr.author.login}, ${threadCount(count)} still unresolved on this pull request.`,
    '',
    'Maintainers review a pull request once every Codex thread has a reply (fixed in which commit, or why not) and is resolved. Outdated threads count too.',
    '',
    `If there is no push or comment from you within ${CODEX_CLOSE_MS / STALE_MS} days after this reminder, the pull request will be closed automatically; you can reopen it once the threads are addressed. Converting it to a draft pauses this.`,
    '',
    '<sub>Automated reminder. It is posted once and updated in place.</sub>',
    '',
  ].join('\n');
}

export function codexClosedBody(pr, count) {
  return [
    MARKERS.codexClosed,
    `Hi @${pr.author.login}, closing this pull request: ${threadCount(count)} still unresolved and there has been no push or comment from you for ${CODEX_CLOSE_MS / STALE_MS} days since the reminder above.`,
    '',
    'Feel free to reopen it once every Codex thread has a reply and is resolved.',
    '',
    '<sub>Automated message.</sub>',
    '',
  ].join('\n');
}

// Pure decision for the Codex reminder. Independent of the CI reminders: a
// pull request can get both.
export function decideCodex(pr, { now }) {
  if (!isEligible(pr) || isBlocked(pr)) return null;
  const since = codexSince(pr);
  if (!isStale(since, now)) return null;
  const count = unresolvedCodexThreads(pr).length;
  return { kind: 'codex', since, count, body: codexBody(pr, count) };
}

// Latest activity by the pull request author (or any push / reopen), or null.
// `activity` is the result of ACTIVITY_QUERY; `comments` are the REST issue
// comments already read for the reminder lookup.
export function lastAuthorActivity(pr, activity, comments) {
  const login = pr.author?.login;
  const times = [
    ...(activity?.commits?.nodes ?? []).flatMap((node) => [
      node.commit?.committedDate,
      ...(node.commit?.checkSuites?.nodes ?? []).map((suite) => suite.createdAt),
    ]),
    ...(activity?.reviewThreads?.nodes ?? []).flatMap((thread) =>
      (thread.comments?.nodes ?? [])
        .filter((comment) => comment.author?.login === login)
        .map((comment) => comment.createdAt),
    ),
    // Pauses end: a draft marked ready or `status:blocked` removed restarts
    // the window like a push does.
    ...(activity?.timelineItems?.nodes ?? [])
      .filter((node) => !node.label || node.label.name === BLOCKED_LABEL)
      .map((node) => node.createdAt),
    ...(activity?.reviews?.nodes ?? [])
      .filter((review) => review.author?.login === login)
      .map((review) => review.submittedAt),
    ...(comments ?? [])
      .filter((comment) => comment.user?.login === login)
      .map((comment) => comment.created_at),
  ].map(time);
  const latest = Math.max(0, ...times);
  return latest ? new Date(latest).toISOString() : null;
}

// Newest unresolved Codex thread, or null.
export function newestCodexThreadAt(pr) {
  const threads = unresolvedCodexThreads(pr);
  if (!threads.length) return null;
  return new Date(
    Math.max(...threads.map((thread) => time(thread.comments.nodes[0].createdAt))),
  ).toISOString();
}

// The close window starts at the reminder, and restarts at any later author
// activity or Codex thread (a thread newer than the reminder was never
// announced to the author).
export function codexCloseDue({ reminderAt, newestThreadAt, lastActivity, now }) {
  const start = Math.max(time(reminderAt), time(newestThreadAt), time(lastActivity));
  return now - start > CODEX_CLOSE_MS;
}

// The most recent reminder of a kind, or null.
export function latestReminder(comments, kind) {
  const matches = comments.filter(
    (comment) =>
      comment.user?.login === BOT_LOGIN &&
      comment.user?.type === 'Bot' &&
      comment.body?.startsWith(MARKERS[kind]),
  );
  return matches.length
    ? matches.reduce((a, b) => (time(b.created_at) > time(a.created_at) ? b : a))
    : null;
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
        labels(first: 100) { nodes { name } }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes { isResolved comments(first: 1) { nodes { author { login } createdAt } } }
        }
      }
    }
  }
}`;

// Only read for pull requests whose Codex reminder is old enough to close.
// Author activity: reviews, thread replies (read from the threads themselves,
// since an inline reply is a review comment) and issue comments. Pushes show up
// as the head commit's check suites (created on push, unlike the commit date)
// or a force-push event; a reopen, a draft marked ready or `status:blocked`
// removed also restarts the window.
const ACTIVITY_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes { commit { committedDate checkSuites(last: 20) { nodes { createdAt } } } }
      }
      reviews(last: 100) { nodes { author { login } submittedAt } }
      reviewThreads(first: 100) {
        nodes { comments(last: 50) { nodes { author { login } createdAt } } }
      }
      timelineItems(
        last: 50
        itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, UNLABELED_EVENT]
      ) {
        nodes {
          ... on HeadRefForcePushedEvent { createdAt }
          ... on ReopenedEvent { createdAt }
          ... on ReadyForReviewEvent { createdAt }
          ... on UnlabeledEvent { createdAt label { name } }
        }
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

  const write = async (count, fn) => {
    if (dryRun) return true;
    if (writes + count > MAX_WRITES_PER_RUN) return false;
    await fn();
    writes += count;
    return true;
  };
  const postComment = (pr, body) =>
    client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      ...repo,
      issue_number: pr.number,
      body,
    });

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
    const decisions = [
      decide(pr, { now, branchRuns, runsBySha, owners, base: pr.baseRefName || defaultBranch }),
      decideCodex(pr, { now }),
    ].filter(Boolean);
    if (!decisions.length) continue;

    const comments = await paginate(
      client,
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...repo, issue_number: pr.number },
      (data) => data,
      10,
    );
    for (const decision of decisions) {
      let existing = findReminder(comments, decision.kind);
      if (decision.kind === 'codex') {
        // Each episode of unresolved threads gets its own reminder: one posted
        // before the oldest current thread belongs to an episode that was
        // already resolved, so it neither starts this close window nor counts
        // as this episode's announcement.
        existing = latestReminder(comments, 'codex');
        if (existing && time(existing.created_at) < time(decision.since)) existing = null;
      }
      let action;
      // Close only when every review thread has been seen: a newer Codex thread
      // on a later page would otherwise not restart the window.
      if (
        decision.kind === 'codex' &&
        existing &&
        !pr.reviewThreads?.pageInfo?.hasNextPage &&
        codexCloseDue({
          reminderAt: existing.created_at,
          newestThreadAt: newestCodexThreadAt(pr),
          lastActivity: null,
          now,
        })
      ) {
        const data = await client.graphql(ACTIVITY_QUERY, { ...repo, number: pr.number });
        const lastActivity = lastAuthorActivity(pr, data.repository.pullRequest, comments);
        if (
          codexCloseDue({
            reminderAt: existing.created_at,
            newestThreadAt: newestCodexThreadAt(pr),
            lastActivity,
            now,
          })
        ) {
          action = 'close';
        }
      }
      if (!action) {
        if (existing && existing.body === decision.body) action = 'unchanged';
        else if (existing) action = 'update';
        else action = 'create';
      }

      let done = true;
      if (action === 'close') {
        // Retry-safe: a closing comment already posted after this reminder (a
        // previous run whose close failed) is not posted again.
        const announced = comments.some(
          (comment) =>
            comment.user?.login === BOT_LOGIN &&
            comment.body?.startsWith(MARKERS.codexClosed) &&
            time(comment.created_at) >= time(existing.created_at),
        );
        done = await write(announced ? 1 : 2, async () => {
          if (!announced) await postComment(pr, codexClosedBody(pr, decision.count));
          await client.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
            ...repo,
            pull_number: pr.number,
            state: 'closed',
          });
        });
      } else if (action === 'update') {
        done = await write(1, () =>
          client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            ...repo,
            comment_id: existing.id,
            body: decision.body,
          }),
        );
      } else if (action === 'create') {
        done = await write(1, () => postComment(pr, decision.body));
      }
      if (!done) action = 'deferred';

      results.push({
        number: pr.number,
        url: pr.url,
        kind: decision.kind,
        since: decision.since,
        action,
      });
      log(
        `#${pr.number} ${decision.kind} since ${decision.since}: ${dryRun && action !== 'unchanged' ? 'would ' : ''}${action}`,
      );
    }
  }
  return { dryRun, owners, scanned: prs.length, results };
}

const REASONS = {
  conflict: 'merge conflict',
  approval: 'workflow approval',
  codex: 'unresolved Codex threads',
};

export function summaryMarkdown({ dryRun, owners, scanned, results }) {
  const lines = [
    `## Stuck pull request reminders${dryRun ? ' (dry run)' : ''}`,
    '',
    `Scanned ${scanned} open pull requests. Global code owners: ${owners.length ? owners.join(' ') : '(none)'}.`,
    '',
    'For conflicts, "stuck since" is the last `pull_request` workflow run (or the creation time): GitHub records no time for when a conflict appeared. For Codex threads, it is the oldest unresolved thread.',
    '',
  ];
  if (!results.length) return [...lines, 'Nothing is stuck.', ''].join('\n');
  lines.push('| Pull request | Reason | Stuck since | Comment |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const reason = REASONS[r.kind];
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
