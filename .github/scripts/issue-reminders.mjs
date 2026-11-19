// Daily lifecycle automation for open issues (see MAINTAINING.md):
//
// - needs-info reply: the issue author commented after `status:needs-info` was
//   added. The label is removed, so the issue is back in triage.
// - needs-info close: no reply from the author for NEEDS_INFO_CLOSE_MS after
//   the label was added (or the issue was reopened). The issue is closed as
//   not planned with a comment saying it can be reopened once the information
//   is added.
// - assigned stale: an assigned issue with no activity for ASSIGNED_STALE_MS
//   gets one reminder asking the assignees whether it is still planned and
//   announcing the close below.
// - assigned close: still no activity for ASSIGNED_CLOSE_MS after that
//   reminder. The issue is closed as not planned. Only a reminder whose body
//   is the current one (so it announced the close) starts the window, from
//   when it was last written: a reminder with older wording is first updated
//   in place, and the window starts at that update.
// - help wanted close: an unassigned `help wanted` issue with no activity for
//   HELP_WANTED_CLOSE_MS is closed as not planned, pointing to Discussions.
//
// "Activity" is the latest of: the issue's creation or reopening, a comment by
// a human (bots never count, including these reminders), a label or assignee
// change, and an update to a linked pull request.
//
// Exempt from every close and reminder: `status:blocked`, `type:epic`,
// `type:rfc`, `priority:P0`, `priority:P1`, pinned issues and issues with a
// linked open pull request. Bot-authored issues are ignored. Removing
// `status:needs-info` after an author reply is never exempt.
//
// Each message is a single comment identified by a hidden marker; a reminder
// is posted once per period of inactivity and updated in place.
//
// The module is used by .github/workflows/issue-reminders.yml through
// actions/github-script. It can also be run locally, always as a dry run:
//   GITHUB_TOKEN=$(gh auth token) node .github/scripts/issue-reminders.mjs
import { pathToFileURL } from 'node:url';
import { fetchClient, isDryRun } from './pr-reminders.mjs';

export { fetchClient, isDryRun };

export const MARKERS = {
  needsInfoClosed: '<!-- openmaic-issue-reminder:needs-info-closed -->',
  assignedStale: '<!-- openmaic-issue-reminder:assigned-stale -->',
  assignedClosed: '<!-- openmaic-issue-reminder:assigned-closed -->',
  helpWantedClosed: '<!-- openmaic-issue-reminder:help-wanted-closed -->',
};
const DAY = 24 * 60 * 60 * 1000;
export const NEEDS_INFO_CLOSE_MS = 14 * DAY;
export const ASSIGNED_STALE_MS = 14 * DAY;
export const ASSIGNED_CLOSE_MS = 7 * DAY;
export const HELP_WANTED_CLOSE_MS = 90 * DAY;
export const MAX_WRITES_PER_RUN = 20;
export const LABELS = {
  needsInfo: 'status:needs-info',
  blocked: 'status:blocked',
  helpWanted: 'help wanted',
};
export const EXEMPT_LABELS = [
  'status:blocked',
  'type:epic',
  'type:rfc',
  'priority:P0',
  'priority:P1',
];
const BOT_LOGIN = 'github-actions[bot]';

function time(value) {
  return value ? Date.parse(value) : 0;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

export function labelNames(issue) {
  return (issue.labels?.nodes ?? []).map((label) => label.name);
}

export function hasLabel(issue, name) {
  return labelNames(issue).includes(name);
}

export function assigneeLogins(issue) {
  return (issue.assignees?.nodes ?? []).map((user) => user.login);
}

function timeline(issue) {
  return issue.timelineItems?.nodes ?? [];
}

export function isEligible(issue) {
  // A deleted author account comes back as `author: null`; its issues still
  // follow the lifecycle. Bot-authored issues (reports, digests) do not.
  return issue.author?.__typename !== 'Bot';
}

// Pull requests linked to the issue: the closing references GitHub shows in
// the Development sidebar, manual links (ConnectedEvent) and same-repository
// pull requests that mention the issue (CrossReferencedEvent).
export function linkedPullRequests(issue, repoName) {
  const prs = [...(issue.closedByPullRequestsReferences?.nodes ?? [])];
  for (const node of timeline(issue)) {
    if (node.__typename === 'ConnectedEvent' && node.subject?.__typename === 'PullRequest') {
      prs.push(node.subject);
    }
    if (
      node.__typename === 'CrossReferencedEvent' &&
      node.source?.__typename === 'PullRequest' &&
      (!repoName || node.source.repository?.nameWithOwner === repoName)
    ) {
      prs.push(node.source);
    }
  }
  return [...new Map(prs.filter(Boolean).map((pr) => [pr.number, pr])).values()];
}

export function linkedOpenPullRequests(issue, repoName) {
  return linkedPullRequests(issue, repoName).filter((pr) => pr.state === 'OPEN');
}

// Why an issue is exempt from closes and staleness reminders, or null.
export function exemptReason(issue, repoName) {
  const label = EXEMPT_LABELS.find((name) => hasLabel(issue, name));
  if (label) return `labelled ${label}`;
  if (issue.isPinned) return 'pinned';
  const open = linkedOpenPullRequests(issue, repoName);
  if (open.length) return `linked open PR #${open[0].number}`;
  return null;
}

export function lastActivity(issue, repoName) {
  const times = [time(issue.createdAt)];
  for (const node of timeline(issue)) {
    switch (node.__typename) {
      case 'IssueComment':
        if (node.author?.__typename !== 'Bot') times.push(time(node.createdAt));
        break;
      case 'LabeledEvent':
      case 'UnlabeledEvent':
      case 'AssignedEvent':
      case 'UnassignedEvent':
      case 'ReopenedEvent':
        times.push(time(node.createdAt));
        break;
      default:
        break;
    }
  }
  for (const pr of linkedPullRequests(issue, repoName)) times.push(time(pr.updatedAt));
  return iso(Math.max(...times));
}

// When `status:needs-info` was last added, by whom, when the reply window
// started (a reopen restarts it) and whether the issue author replied since.
// Null when the issue has no such label, or the event is out of reach.
export function needsInfoState(issue) {
  if (!hasLabel(issue, LABELS.needsInfo)) return null;
  const nodes = timeline(issue);
  const labeled = nodes
    .filter((node) => node.__typename === 'LabeledEvent' && node.label?.name === LABELS.needsInfo)
    .reduce((a, b) => (time(b.createdAt) > time(a?.createdAt) ? b : a), null);
  if (!labeled) return null;
  const labeledAt = time(labeled.createdAt);
  const reopenedAt = Math.max(
    0,
    ...nodes
      .filter((node) => node.__typename === 'ReopenedEvent')
      .map((node) => time(node.createdAt)),
  );
  const author = issue.author?.login;
  const reply = nodes
    .filter(
      (node) =>
        node.__typename === 'IssueComment' &&
        author &&
        node.author?.login === author &&
        time(node.createdAt) > labeledAt,
    )
    .reduce((a, b) => (time(b.createdAt) > time(a?.createdAt) ? b : a), null);
  return {
    labeledAt: labeled.createdAt,
    labeledBy: labeled.actor?.login ?? null,
    since: iso(Math.max(labeledAt, reopenedAt)),
    repliedAt: reply?.createdAt ?? null,
  };
}

const repoUrl = (repo) => `https://github.com/${repo.owner}/${repo.repo}`;
const ideasUrl = (repo) => `${repoUrl(repo)}/discussions/new?category=ideas`;

export function needsInfoClosedBody(issue) {
  const who = issue.author?.login ? `@${issue.author.login}` : 'the reporter';
  return [
    MARKERS.needsInfoClosed,
    `Closing this issue as not planned for now: it has been waiting ${NEEDS_INFO_CLOSE_MS / DAY} days for more information from ${who}.`,
    '',
    'It can be reopened once the information is added. Reply here with the requested details; if you cannot reopen the issue yourself, a maintainer will.',
    '',
    '<sub>Automated message. See MAINTAINING.md for the issue lifecycle.</sub>',
    '',
  ].join('\n');
}

export function assignedStaleBody(issue) {
  const who = assigneeLogins(issue)
    .map((login) => `@${login}`)
    .join(' ');
  return [
    MARKERS.assignedStale,
    `Hi ${who}, this issue has had no activity for ${ASSIGNED_STALE_MS / DAY} days. Is it still planned?`,
    '',
    '- If yes, a short status comment is enough.',
    '- If not, please unassign yourself and mark it `help wanted` (or say so here and a maintainer will), or close it if it is no longer needed.',
    '',
    `If there is no activity within ${ASSIGNED_CLOSE_MS / DAY} days after this reminder, the issue will be closed as not planned; it can be reopened later.`,
    '',
    '<sub>Automated reminder. It is posted once per period of inactivity and updated in place.</sub>',
    '',
  ].join('\n');
}

export function assignedClosedBody(issue) {
  const who = assigneeLogins(issue)
    .map((login) => `@${login}`)
    .join(' ');
  return [
    MARKERS.assignedClosed,
    `Hi ${who}, closing this issue as not planned: there has been no activity for ${ASSIGNED_CLOSE_MS / DAY} days since the reminder above.`,
    '',
    'If it is still planned, comment here and it can be reopened.',
    '',
    '<sub>Automated message. See MAINTAINING.md for the issue lifecycle.</sub>',
    '',
  ].join('\n');
}

export function helpWantedClosedBody(issue, repo) {
  return [
    MARKERS.helpWantedClosed,
    `Closing this issue as not planned: it has been open for contributors (\`help wanted\`) with no activity for ${HELP_WANTED_CLOSE_MS / DAY} days.`,
    '',
    `If you would still like to see this, please describe the use case in [Discussions → Ideas](${ideasUrl(repo)}). If you plan to work on it yourself, comment here and a maintainer can reopen it.`,
    '',
    '<sub>Automated message. See MAINTAINING.md for the issue lifecycle.</sub>',
    '',
  ].join('\n');
}

// Pure decision for one issue: at most one action per run.
export function decide(issue, { now, repo }) {
  if (!isEligible(issue)) return null;
  const repoName = `${repo.owner}/${repo.repo}`;
  const needsInfo = needsInfoState(issue);
  if (hasLabel(issue, LABELS.needsInfo)) {
    if (!needsInfo) return null;
    if (needsInfo.repliedAt) {
      return { kind: 'needsInfoReplied', since: needsInfo.repliedAt };
    }
    if (exemptReason(issue, repoName)) return null;
    if (now - time(needsInfo.since) <= NEEDS_INFO_CLOSE_MS) return null;
    return { kind: 'needsInfoClosed', since: needsInfo.since, body: needsInfoClosedBody(issue) };
  }
  if (exemptReason(issue, repoName)) return null;
  const since = lastActivity(issue, repoName);
  const idle = now - time(since);
  if (assigneeLogins(issue).length) {
    if (idle <= ASSIGNED_STALE_MS) return null;
    return { kind: 'assignedStale', since, body: assignedStaleBody(issue) };
  }
  if (hasLabel(issue, LABELS.helpWanted)) {
    if (idle <= HELP_WANTED_CLOSE_MS) return null;
    return { kind: 'helpWantedClosed', since, body: helpWantedClosedBody(issue, repo) };
  }
  return null;
}

// The most recent bot comment of a kind, or null.
export function latestMessage(comments, kind) {
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

// When a message was last written: an update in place restarts its window.
export function writtenAt(comment) {
  return comment.updated_at ?? comment.created_at;
}

// An assigned-stale reminder closes the issue ASSIGNED_CLOSE_MS after it was
// last written, but only if its body is the current one: a reminder with older
// wording never announced the close and is updated first. Activity after the
// reminder starts a new period of inactivity, so `decide` drops the decision
// or the reminder stops being current before this is reached.
export function assignedCloseDue(reminder, body, now) {
  return reminder.body === body && now - time(writtenAt(reminder)) > ASSIGNED_CLOSE_MS;
}

// ---- GitHub access (an octokit-compatible `request` / `graphql` client) ----

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt isPinned
        author { login __typename }
        assignees(first: 10) { nodes { login } }
        labels(first: 50) { nodes { name } }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          nodes { number state updatedAt }
        }
        timelineItems(
          last: 100
          itemTypes: [ISSUE_COMMENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, REOPENED_EVENT, CONNECTED_EVENT, CROSS_REFERENCED_EVENT]
        ) {
          nodes {
            __typename
            ... on IssueComment { createdAt author { login __typename } }
            ... on LabeledEvent { createdAt label { name } actor { login } }
            ... on UnlabeledEvent { createdAt label { name } }
            ... on AssignedEvent { createdAt }
            ... on UnassignedEvent { createdAt }
            ... on ReopenedEvent { createdAt }
            ... on ConnectedEvent {
              createdAt
              subject { __typename ... on PullRequest { number state updatedAt } }
            }
            ... on CrossReferencedEvent {
              createdAt
              source {
                __typename
                ... on PullRequest { number state updatedAt repository { nameWithOwner } }
              }
            }
          }
        }
      }
    }
  }
}`;

export async function listOpenIssues(client, repo, { maxPages = 20 } = {}) {
  const issues = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.graphql(ISSUE_QUERY, { ...repo, cursor });
    const { nodes, pageInfo } = data.repository.issues;
    issues.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return issues;
}

async function listComments(client, repo, number) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await client.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...repo, issue_number: number, per_page: 100, page },
    );
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

export async function run({ client, repo, now = Date.now(), dryRun = true, log = console.log }) {
  const issues = await listOpenIssues(client, repo);
  const results = [];
  let writes = 0;

  const write = async (count, fn) => {
    if (dryRun) return true;
    if (writes + count > MAX_WRITES_PER_RUN) return false;
    await fn();
    writes += count;
    return true;
  };
  const params = (issue) => ({ ...repo, issue_number: issue.number });
  const postComment = (issue, body) =>
    client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      ...params(issue),
      body,
    });
  const closeNotPlanned = (issue) =>
    client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      ...params(issue),
      state: 'closed',
      state_reason: 'not_planned',
    });

  for (const issue of issues) {
    const decision = decide(issue, { now, repo });
    if (!decision) continue;
    let action;
    let done = true;

    if (decision.kind === 'needsInfoReplied') {
      action = 'remove label';
      done = await write(1, () =>
        client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
          ...params(issue),
          name: LABELS.needsInfo,
        }),
      );
    } else {
      const comments = await listComments(client, repo, issue.number);
      const existing = latestMessage(comments, decision.kind);
      // A message older than the current window belongs to an earlier episode.
      const current = existing && time(existing.created_at) >= time(decision.since);
      if (decision.kind === 'assignedStale') {
        const due = current && assignedCloseDue(existing, decision.body, now);
        if (due) {
          // Retry-safe: a closing comment already posted after the reminder
          // (a previous run whose close failed) is not posted again.
          const closing = latestMessage(comments, 'assignedClosed');
          const announced = closing && time(closing.created_at) >= time(writtenAt(existing));
          action = 'close';
          done = await write(announced ? 1 : 2, async () => {
            if (!announced) await postComment(issue, assignedClosedBody(issue));
            await closeNotPlanned(issue);
          });
        } else if (current && existing.body === decision.body) action = 'unchanged';
        else if (current) {
          action = 'update';
          done = await write(1, () =>
            client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
              ...repo,
              comment_id: existing.id,
              body: decision.body,
            }),
          );
        } else {
          action = 'create';
          done = await write(1, () => postComment(issue, decision.body));
        }
      } else {
        // Retry-safe: a closing comment already posted in this window (a
        // previous run whose close failed) is not posted again.
        action = 'close';
        done = await write(current ? 1 : 2, async () => {
          if (!current) await postComment(issue, decision.body);
          await closeNotPlanned(issue);
        });
      }
    }
    if (!done) action = 'deferred';

    results.push({
      number: issue.number,
      url: issue.url,
      kind: decision.kind,
      since: decision.since,
      action,
    });
    log(
      `#${issue.number} ${decision.kind} since ${decision.since}: ${dryRun && action !== 'unchanged' ? 'would ' : ''}${action}`,
    );
  }
  return { dryRun, scanned: issues.length, results };
}

const REASONS = {
  needsInfoReplied: 'author replied to `status:needs-info`',
  needsInfoClosed: `no reply to \`status:needs-info\` for ${NEEDS_INFO_CLOSE_MS / DAY} days`,
  assignedStale: `assigned, no activity for ${ASSIGNED_STALE_MS / DAY} days (closed ${ASSIGNED_CLOSE_MS / DAY} days after the reminder)`,
  helpWantedClosed: `\`help wanted\`, no activity for ${HELP_WANTED_CLOSE_MS / DAY} days`,
};

export function summaryMarkdown({ dryRun, scanned, results }) {
  const lines = [
    `## Issue lifecycle reminders${dryRun ? ' (dry run)' : ''}`,
    '',
    `Scanned ${scanned} open issues. "Since" is the reply, the start of the reply window, or the last activity.`,
    '',
  ];
  if (!results.length) return [...lines, 'Nothing to do.', ''].join('\n');
  lines.push('| Issue | Reason | Since | Action |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const action = dryRun && r.action !== 'unchanged' ? `would ${r.action}` : r.action;
    lines.push(`| [#${r.number}](${r.url}) | ${REASONS[r.kind]} | ${r.since} | ${action} |`);
  }
  return [...lines, ''].join('\n');
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
