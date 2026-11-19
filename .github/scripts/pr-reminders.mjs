// Daily reminders for open pull requests that are stuck:
//
// - conflict: the pull request conflicts with its base branch. GitHub does not
//   start `pull_request` workflows for it, so pushes go unchecked and the
//   author is often unaware.
// - approval: workflow runs for the head commit wait in `action_required`
//   until a maintainer approves them (first-time fork contributors). This is
//   not the author's to fix, so it never leads to a close.
// - ci: checks on the head commit have failed for over a day.
// - codex: Codex review threads stay unresolved for over a day. Maintainers
//   review a pull request once every Codex thread has a reply and is resolved.
//
// A pull request gets at most one of conflict, approval and ci, in that order:
// CI cannot run while it conflicts, and a run waiting for approval is not the
// author's fault. Codex is independent of them.
//
// conflict, ci and codex mean the pull request is not ready for review. If the
// author shows no activity (push, comment, review or thread reply) for
// CLOSE_MS after the reminder, the pull request is closed with one comment
// listing every reason that is due, saying it can be reopened once they are
// addressed. Only a reminder that announced the close starts the window: a
// reminder with older wording is first updated in place, and the window starts
// at that update. Pull requests labelled `status:blocked` are never closed
// (the ball is with the maintainers) and get no Codex reminder.
//
// Drafts and bot-authored pull requests are never reminded or closed.
//
// Each reminder is a comment identified by a hidden marker. Later runs update
// that comment in place (no new notification) instead of reposting. A new
// episode (conflict, failing CI or Codex threads that start after the last
// reminder was written) gets a new reminder and a new window.
//
// The module is used by .github/workflows/pr-reminders.yml through
// actions/github-script. It can also be run locally, always as a dry run:
//   GITHUB_TOKEN=$(gh auth token) node .github/scripts/pr-reminders.mjs
import { pathToFileURL } from 'node:url';

export const MARKERS = {
  conflict: '<!-- openmaic-pr-reminder:conflict -->',
  approval: '<!-- openmaic-pr-reminder:approval -->',
  ci: '<!-- openmaic-pr-reminder:ci -->',
  codex: '<!-- openmaic-pr-reminder:codex -->',
  closed: '<!-- openmaic-pr-reminder:closed -->',
  // Closing comments posted before the generic marker existed.
  codexClosed: '<!-- openmaic-pr-reminder:codex-closed -->',
};
export const STALE_MS = 24 * 60 * 60 * 1000;
export const CLOSE_MS = 7 * 24 * 60 * 60 * 1000;
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
export const BLOCKED_LABEL = 'status:blocked';
const CODEX_LOGIN = 'chatgpt-codex-connector';
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

// Failing check contexts on the head commit: CheckRun conclusions in
// FAILURE / TIMED_OUT / STARTUP_FAILURE (not CANCELLED, ACTION_REQUIRED,
// NEUTRAL or SKIPPED), and StatusContext states FAILURE / ERROR. Returns the
// earliest completion time among the failing contexts and the sorted, deduped
// failing names, or null when nothing is failing.
export function failingChecks(pr) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failing = [];
  for (const ctx of contexts) {
    if (ctx.__typename === 'CheckRun') {
      if (FAILING_CONCLUSIONS.has(ctx.conclusion)) {
        failing.push({ name: ctx.name, at: ctx.completedAt });
      }
    } else if (ctx.__typename === 'StatusContext') {
      if (FAILING_STATES.has(ctx.state)) {
        failing.push({ name: ctx.context, at: ctx.createdAt });
      }
    }
  }
  if (!failing.length) return null;
  const names = [...new Set(failing.map((f) => f.name))].sort();
  const times = failing.map((f) => time(f.at)).filter(Boolean);
  // No timestamp yet: not known to be stale, so wait for the next run.
  const since = times.length ? new Date(Math.min(...times)).toISOString() : null;
  return { names, since };
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

// Hidden line recording the head commit a reminder was written for. GitHub
// starts no checks on a conflicting pull request, and pushed commits can carry
// old commit dates, so a push may leave no other trace in the API. A new head
// changes the body: the reminder is updated in place, which restarts its close
// window.
function headLine(pr) {
  return `<!-- head: ${pr.headRefOid} -->`;
}

// The sentence that announces the close. Left out for `status:blocked` pull
// requests, which are never closed; removing the label changes the body, so
// the reminder is updated and only then starts the close window.
function closeNotice(fixed, close) {
  return close
    ? [
        `If there is no push or comment from you within ${CLOSE_MS / STALE_MS} days after this reminder, the pull request will be closed automatically; you can reopen it once ${fixed}. Converting it to a draft pauses this.`,
        '',
      ]
    : [];
}

export function conflictBody(pr, base, { close = true } = {}) {
  return [
    MARKERS.conflict,
    headLine(pr),
    `Hi @${pr.author.login}, this pull request has merge conflicts with \`${base}\` and CI has not been able to run on it for over a day.`,
    '',
    'GitHub does not start `pull_request` workflows while a pull request has conflicts, so recent pushes have not been checked. Please merge or rebase onto the latest `' +
      base +
      '` and resolve the conflicts; CI runs again on the next push.',
    '',
    ...closeNotice('the conflicts are resolved', close),
    'If this pull request is still a work in progress, converting it to a draft stops this reminder. If it is no longer needed, feel free to close it.',
    '',
    '<sub>Automated reminder. It is posted once and updated in place.</sub>',
    '',
  ].join('\n');
}

function checkList(names) {
  return names.map((name) => `\`${name}\``).join(', ');
}

export function ciBody(pr, names, { close = true } = {}) {
  return [
    MARKERS.ci,
    headLine(pr),
    `Hi @${pr.author.login}, CI has been failing on the latest commit of this pull request for over a day: ${checkList(names)}.`,
    '',
    'Please push a fix. If a failure is unrelated to this change (for example a flaky test or an outage), say so in a comment so a maintainer can re-run it.',
    '',
    ...closeNotice('CI passes', close),
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

// Pure decision for one pull request. Priority: conflict > approval > ci.
// A conflicting pull request only gets the conflict reminder (CI cannot run
// while it conflicts). A pull request waiting for approval is not the author's
// fault, so approval never leads to a close. Unknown mergeability is left for
// the next run.
export function decide(pr, { now, branchRuns, runsBySha, owners, base }) {
  if (!isEligible(pr) || pr.mergeable === 'UNKNOWN') return null;
  const blocked = isBlocked(pr);
  if (pr.mergeable === 'CONFLICTING') {
    const since = conflictSince(pr, branchRuns ?? []);
    if (!isStale(since, now)) return null;
    const resolvedBase = base ?? pr.baseRefName;
    return {
      kind: 'conflict',
      since,
      base: resolvedBase,
      body: conflictBody(pr, resolvedBase, { close: !blocked }),
    };
  }
  // Any run on the head waiting for approval, stale or not, rules out the CI
  // decision: the remaining checks have not run yet, so the author cannot be
  // asked to fix CI or be closed for it.
  const appSince = approvalSince(pr, runsBySha);
  if (appSince !== null) {
    if (!isStale(appSince, now)) return null;
    return {
      kind: 'approval',
      since: appSince,
      body: approvalBody(pr, runsBySha.get(pr.headRefOid), owners),
    };
  }
  const checks = failingChecks(pr);
  if (!checks) return null;
  if (!isStale(checks.since, now)) return null;
  return {
    kind: 'ci',
    since: checks.since,
    names: checks.names,
    body: ciBody(pr, checks.names, { close: !blocked }),
  };
}

// Unresolved review threads opened by Codex. Outdated threads still count:
// the author is expected to reply and resolve them.
export function unresolvedCodexThreads(pr) {
  return (pr.reviewThreads?.nodes ?? []).filter((thread) => {
    const first = thread.comments?.nodes?.[0];
    // The Codex app itself: an exact bot login, so a user account with a
    // look-alike name cannot open threads that count against a PR.
    return (
      !thread.isResolved &&
      first?.author?.login === CODEX_LOGIN &&
      first.author.__typename === 'Bot'
    );
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
    headLine(pr),
    `Hi @${pr.author.login}, ${threadCount(count)} still unresolved on this pull request.`,
    '',
    'Maintainers review a pull request once every Codex thread has a reply (fixed in which commit, or why not) and is resolved. Outdated threads count too.',
    '',
    `If there is no push or comment from you within ${CLOSE_MS / STALE_MS} days after this reminder, the pull request will be closed automatically; you can reopen it once the threads are addressed. Converting it to a draft pauses this.`,
    '',
    '<sub>Automated reminder. It is posted once and updated in place.</sub>',
    '',
  ].join('\n');
}

const CLOSE_REASONS = {
  codex: (decision) => `${threadCount(decision.count)} still unresolved.`,
  conflict: (decision) => `It has merge conflicts with \`${decision.base}\`.`,
  ci: (decision) => `CI is failing: ${checkList(decision.names)}.`,
};

// One closing comment for every reason that is due on this run.
export function closedBody(pr, decisions) {
  return [
    MARKERS.closed,
    `Hi @${pr.author.login}, closing this pull request: there has been no push or comment from you for ${CLOSE_MS / STALE_MS} days since the reminder above, and it is not ready for review:`,
    '',
    ...decisions.map((decision) => `- ${CLOSE_REASONS[decision.kind](decision)}`),
    '',
    'Feel free to reopen it once these are addressed. Reopen it before you push: GitHub cannot reopen a pull request whose branch was force-pushed while it was closed.',
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
// activity or (for codex) Codex thread: a thread newer than the reminder was
// never announced to the author.
export function closeDue({ reminderAt, newestThreadAt = null, lastActivity, now }) {
  const start = Math.max(time(reminderAt), time(newestThreadAt), time(lastActivity));
  return now - start > CLOSE_MS;
}

// When a reminder was last written: an update in place restarts its window.
export function writtenAt(comment) {
  return comment.updated_at ?? comment.created_at;
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

// The reminder that belongs to the current episode of a decision, and whether
// it can start a close window. Approval never closes and keeps its single
// comment. For conflict, ci and codex, only a reminder whose body is the
// current one (it announced the close and names the current head) counts,
// from when it was last written; any other body is updated first. Codex
// windows also restart at a newer thread.
export function reminderPlan(pr, decision, comments) {
  if (decision.kind === 'approval') {
    return { existing: findReminder(comments, 'approval'), window: null };
  }
  // A reminder written before the current episode began belongs to an earlier
  // one: it neither starts this window nor counts as this episode's reminder.
  let existing = latestReminder(comments, decision.kind);
  const at = decision.kind === 'codex' ? existing?.created_at : existing && writtenAt(existing);
  if (existing && time(at) < time(decision.since)) existing = null;
  if (!existing || isBlocked(pr)) return { existing, window: null };
  // Only a reminder whose body is the current one counts: it announced the
  // close and was written for the current head. Any other body is updated
  // first, and the window starts at that update.
  if (existing.body !== decision.body) return { existing, window: null };
  if (decision.kind === 'codex') {
    // Close only when every review thread has been seen: a newer Codex thread
    // on a later page would otherwise not restart the window.
    if (pr.reviewThreads?.pageInfo?.hasNextPage) return { existing, window: null };
    return {
      existing,
      window: { reminderAt: writtenAt(existing), newestThreadAt: newestCodexThreadAt(pr) },
    };
  }
  return { existing, window: { reminderAt: writtenAt(existing) } };
}

function isClosingComment(comment) {
  return (
    comment.user?.login === BOT_LOGIN &&
    (comment.body?.startsWith(MARKERS.closed) || comment.body?.startsWith(MARKERS.codexClosed))
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
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion completedAt }
                    ... on StatusContext { context state createdAt }
                  }
                }
              }
            }
          }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            isResolved
            comments(first: 1) { nodes { author { login __typename } createdAt } }
          }
        }
      }
    }
  }
}`;

// Only read for pull requests with a reminder old enough to close.
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
    const report = (decision, action) => {
      results.push({
        number: pr.number,
        url: pr.url,
        kind: decision.kind,
        since: decision.since,
        checks: decision.names,
        action,
      });
      log(
        `#${pr.number} ${decision.kind} since ${decision.since}: ${dryRun && action !== 'unchanged' ? 'would ' : ''}${action}`,
      );
    };

    const plans = decisions.map((decision) => ({
      decision,
      ...reminderPlan(pr, decision, comments),
    }));
    // Author activity is only read when some reminder is old enough to close.
    const candidates = plans.filter(
      (plan) => plan.window && closeDue({ ...plan.window, lastActivity: null, now }),
    );
    let due = [];
    let lastActivity = null;
    if (candidates.length) {
      const data = await client.graphql(ACTIVITY_QUERY, { ...repo, number: pr.number });
      lastActivity = lastAuthorActivity(pr, data.repository.pullRequest, comments);
      due = candidates.filter((plan) => closeDue({ ...plan.window, lastActivity, now }));
    }

    if (due.length) {
      // One close per pull request, with one comment listing every due reason.
      // Retry-safe: a closing comment already posted in this window (a previous
      // run whose close failed) is not posted again.
      const windowStart = Math.max(
        time(lastActivity),
        ...due.map((plan) => time(plan.window.reminderAt)),
      );
      const announced = comments.some(
        (comment) => isClosingComment(comment) && time(comment.created_at) >= windowStart,
      );
      const reasons = due.map((plan) => plan.decision);
      const done = await write(announced ? 1 : 2, async () => {
        if (!announced) await postComment(pr, closedBody(pr, reasons));
        await client.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...repo,
          pull_number: pr.number,
          state: 'closed',
        });
      });
      for (const decision of reasons) report(decision, done ? 'close' : 'deferred');
      continue;
    }

    for (const { decision, existing } of plans) {
      let action;
      if (existing && existing.body === decision.body) action = 'unchanged';
      else if (existing) action = 'update';
      else action = 'create';

      let done = true;
      if (action === 'update') {
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
      report(decision, done ? action : 'deferred');
    }
  }
  return { dryRun, owners, scanned: prs.length, results };
}

const REASONS = {
  conflict: 'merge conflict',
  approval: 'workflow approval',
  ci: 'failing CI',
  codex: 'unresolved Codex threads',
};

export function summaryMarkdown({ dryRun, owners, scanned, results }) {
  const lines = [
    `## Stuck pull request reminders${dryRun ? ' (dry run)' : ''}`,
    '',
    `Scanned ${scanned} open pull requests. Global code owners: ${owners.length ? owners.join(' ') : '(none)'}.`,
    '',
    'For conflicts, "stuck since" is the last `pull_request` workflow run (or the creation time): GitHub records no time for when a conflict appeared. For failing CI, it is the earliest completion of a failing check on the head commit. For Codex threads, it is the oldest unresolved thread.',
    '',
  ];
  if (!results.length) return [...lines, 'Nothing is stuck.', ''].join('\n');
  lines.push('| Pull request | Reason | Stuck since | Comment |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const reason = r.checks?.length
      ? `${REASONS[r.kind]} (${checkList(r.checks)})`
      : REASONS[r.kind];
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
