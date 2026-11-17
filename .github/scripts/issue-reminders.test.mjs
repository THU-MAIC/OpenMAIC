import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSIGNED_STALE_MS,
  EXEMPT_LABELS,
  HELP_WANTED_CLOSE_MS,
  MARKERS,
  MAX_WRITES_PER_RUN,
  NEEDS_INFO_CLOSE_MS,
  assignedStaleBody,
  decide,
  exemptReason,
  helpWantedClosedBody,
  isDryRun,
  lastActivity,
  latestMessage,
  linkedOpenPullRequests,
  needsInfoClosedBody,
  needsInfoState,
  run,
  summaryMarkdown,
} from './issue-reminders.mjs';

const repo = { owner: 'THU-MAIC', repo: 'OpenMAIC' };
const repoName = 'THU-MAIC/OpenMAIC';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const makeIssue = (number, { labels = [], assignees = [], events = [], ...extras } = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/THU-MAIC/OpenMAIC/issues/${number}`,
  createdAt: ago(400 * DAY),
  isPinned: false,
  author: { login: `author${number}`, __typename: 'User' },
  assignees: { nodes: assignees.map((login) => ({ login })) },
  labels: { nodes: labels.map((name) => ({ name })) },
  closedByPullRequestsReferences: { nodes: [] },
  timelineItems: { nodes: events },
  ...extras,
});
const labeled = (name, at, actor = 'maintainer') => ({
  __typename: 'LabeledEvent',
  createdAt: at,
  label: { name },
  actor: { login: actor },
});
const comment = (login, at, type = 'User') => ({
  __typename: 'IssueComment',
  createdAt: at,
  author: { login, __typename: type },
});
const event = (__typename, at) => ({ __typename, createdAt: at });
const pr = (number, state, updatedAt = ago(300 * DAY)) => ({ number, state, updatedAt });
const crossRef = (source, at = ago(300 * DAY)) => ({
  __typename: 'CrossReferencedEvent',
  createdAt: at,
  source: { __typename: 'PullRequest', repository: { nameWithOwner: repoName }, ...source },
});
const botComment = (id, body, created_at) => ({
  id,
  body,
  created_at,
  user: { login: 'github-actions[bot]', type: 'Bot' },
});
const needsInfo = (number, labelAge, extras = {}) =>
  makeIssue(number, {
    labels: ['bug', 'status:needs-info'],
    events: [labeled('status:needs-info', ago(labelAge))],
    ...extras,
  });
const assigned = (number, idle, extras = {}) =>
  makeIssue(number, {
    labels: ['bug'],
    assignees: ['owner1'],
    events: [event('AssignedEvent', ago(idle))],
    ...extras,
  });
const helpWanted = (number, idle, extras = {}) =>
  makeIssue(number, {
    labels: ['enhancement', 'help wanted'],
    events: [labeled('help wanted', ago(idle))],
    ...extras,
  });

test('dry run is the default unless the repository variable says apply', () => {
  assert.equal(isDryRun('schedule', '', ''), true);
  assert.equal(isDryRun('schedule', '', 'apply'), false);
  assert.equal(isDryRun('workflow_dispatch', '', 'apply'), true);
  assert.equal(isDryRun('workflow_dispatch', 'false', ''), false);
});

test('needs-info state tracks the latest label, the author reply and reopens', () => {
  const issue = needsInfo(1, 20 * DAY, {
    events: [
      labeled('status:needs-info', ago(30 * DAY)),
      comment('author1', ago(25 * DAY)),
      labeled('status:needs-info', ago(20 * DAY), 'triager'),
      comment('someone-else', ago(5 * DAY)),
    ],
  });
  assert.deepEqual(needsInfoState(issue), {
    labeledAt: ago(20 * DAY),
    labeledBy: 'triager',
    since: ago(20 * DAY),
    repliedAt: null,
  });
  issue.timelineItems.nodes.push(
    event('ReopenedEvent', ago(3 * DAY)),
    comment('author1', ago(DAY)),
  );
  assert.equal(needsInfoState(issue).since, ago(3 * DAY));
  assert.equal(needsInfoState(issue).repliedAt, ago(DAY));
  assert.equal(needsInfoState(makeIssue(2)), null);
  // Labelled, but the event is out of reach: no decision.
  assert.equal(needsInfoState(makeIssue(3, { labels: ['status:needs-info'] })), null);
});

test('an author reply removes needs-info, even on an exempt issue', () => {
  const replied = needsInfo(4, 20 * DAY, {
    labels: ['status:needs-info', 'priority:P0'],
    events: [labeled('status:needs-info', ago(20 * DAY)), comment('author4', ago(2 * DAY))],
  });
  assert.deepEqual(decide(replied, { now: NOW, repo }), {
    kind: 'needsInfoReplied',
    since: ago(2 * DAY),
  });
});

test('needs-info closes strictly after 14 days without an author reply', () => {
  const due = decide(needsInfo(5, NEEDS_INFO_CLOSE_MS + 1), { now: NOW, repo });
  assert.equal(due.kind, 'needsInfoClosed');
  assert.ok(due.body.startsWith(MARKERS.needsInfoClosed));
  assert.equal(decide(needsInfo(6, NEEDS_INFO_CLOSE_MS), { now: NOW, repo }), null);
  // Other people commenting does not count as the reply.
  const others = needsInfo(7, 20 * DAY, {
    events: [
      labeled('status:needs-info', ago(20 * DAY)),
      comment('maintainer', ago(DAY)),
      comment('author7', ago(21 * DAY)),
    ],
  });
  assert.equal(decide(others, { now: NOW, repo }).kind, 'needsInfoClosed');
  // A reopen restarts the window.
  const reopened = needsInfo(8, 20 * DAY, {
    events: [labeled('status:needs-info', ago(20 * DAY)), event('ReopenedEvent', ago(DAY))],
  });
  assert.equal(decide(reopened, { now: NOW, repo }), null);
});

test('needs-info issues are never treated as stale assigned or help wanted issues', () => {
  const issue = needsInfo(9, 2 * DAY, { assignees: ['owner1'] });
  assert.equal(decide(issue, { now: NOW, repo }), null);
});

test('an assigned issue is reminded strictly after 60 days without activity', () => {
  const due = decide(assigned(10, ASSIGNED_STALE_MS + 1), { now: NOW, repo });
  assert.equal(due.kind, 'assignedStale');
  assert.equal(due.since, ago(ASSIGNED_STALE_MS + 1));
  assert.equal(decide(assigned(11, ASSIGNED_STALE_MS), { now: NOW, repo }), null);
});

test('an unassigned help wanted issue closes strictly after 90 days without activity', () => {
  const due = decide(helpWanted(12, HELP_WANTED_CLOSE_MS + 1), { now: NOW, repo });
  assert.equal(due.kind, 'helpWantedClosed');
  assert.equal(decide(helpWanted(13, HELP_WANTED_CLOSE_MS), { now: NOW, repo }), null);
  // Assigned and help wanted: someone owns it, so it gets the assignee reminder.
  const both = helpWanted(14, HELP_WANTED_CLOSE_MS + 1, {
    assignees: ['contributor'],
  });
  assert.equal(decide(both, { now: NOW, repo }).kind, 'assignedStale');
});

test('untriaged and accepted-but-active issues are left alone', () => {
  assert.equal(decide(makeIssue(15, { labels: ['bug'] }), { now: NOW, repo }), null);
  assert.equal(decide(assigned(16, 10 * DAY), { now: NOW, repo }), null);
});

test('activity counts human comments, label and assignee changes, reopens and linked PRs', () => {
  const base = { createdAt: ago(500 * DAY) };
  const at = (events, extras = {}) =>
    lastActivity(makeIssue(17, { ...base, events, ...extras }), repoName);
  assert.equal(at([]), ago(500 * DAY));
  assert.equal(at([comment('user', ago(70 * DAY))]), ago(70 * DAY));
  // Bot comments, including these reminders, never count.
  assert.equal(at([comment('github-actions', ago(DAY), 'Bot')]), ago(500 * DAY));
  for (const type of ['UnlabeledEvent', 'AssignedEvent', 'UnassignedEvent', 'ReopenedEvent']) {
    assert.equal(at([event(type, ago(9 * DAY))]), ago(9 * DAY));
  }
  assert.equal(at([labeled('bug', ago(8 * DAY))]), ago(8 * DAY));
  assert.equal(
    at([], { closedByPullRequestsReferences: { nodes: [pr(1, 'MERGED', ago(7 * DAY))] } }),
    ago(7 * DAY),
  );
  assert.equal(at([crossRef(pr(2, 'CLOSED', ago(6 * DAY)))]), ago(6 * DAY));
  assert.equal(
    at([
      {
        __typename: 'ConnectedEvent',
        createdAt: ago(400 * DAY),
        subject: { __typename: 'PullRequest', ...pr(3, 'CLOSED', ago(5 * DAY)) },
      },
    ]),
    ago(5 * DAY),
  );
});

test('linked open pull requests come from closing references, links and same-repo mentions', () => {
  const issue = makeIssue(18, {
    closedByPullRequestsReferences: { nodes: [pr(1, 'MERGED'), pr(2, 'OPEN')] },
    events: [
      crossRef(pr(3, 'OPEN')),
      crossRef({ ...pr(4, 'OPEN'), repository: { nameWithOwner: 'someone/fork' } }),
      {
        __typename: 'CrossReferencedEvent',
        createdAt: ago(DAY),
        source: { __typename: 'Issue', number: 5 },
      },
      {
        __typename: 'ConnectedEvent',
        createdAt: ago(DAY),
        subject: { __typename: 'PullRequest', ...pr(6, 'OPEN') },
      },
    ],
  });
  assert.deepEqual(
    linkedOpenPullRequests(issue, repoName).map((p) => p.number),
    [2, 3, 6],
  );
});

test('every exemption blocks staleness reminders and needs-info closes', () => {
  const variants = [
    ...EXEMPT_LABELS.map((label) => ({ label })),
    { isPinned: true },
    { closedByPullRequestsReferences: { nodes: [pr(9, 'OPEN')] } },
    { linkedEvent: crossRef(pr(10, 'OPEN')) },
  ];
  for (const variant of variants) {
    const apply = (issue) => {
      if (variant.label) issue.labels.nodes.push({ name: variant.label });
      if (variant.isPinned) issue.isPinned = true;
      if (variant.closedByPullRequestsReferences)
        issue.closedByPullRequestsReferences = variant.closedByPullRequestsReferences;
      if (variant.linkedEvent) issue.timelineItems.nodes.push(variant.linkedEvent);
      return issue;
    };
    const stale = apply(assigned(20, 100 * DAY));
    // A linked PR updated long ago keeps the issue idle; it is still exempt.
    assert.ok(exemptReason(stale, repoName), JSON.stringify(variant));
    assert.equal(decide(stale, { now: NOW, repo }), null, JSON.stringify(variant));
    assert.equal(
      decide(apply(helpWanted(21, 200 * DAY)), { now: NOW, repo }),
      null,
      JSON.stringify(variant),
    );
    assert.equal(
      decide(apply(needsInfo(22, 30 * DAY)), { now: NOW, repo }),
      null,
      JSON.stringify(variant),
    );
  }
  assert.equal(exemptReason(assigned(23, 100 * DAY), repoName), null);
});

test('bot-authored issues are ignored; deleted authors still follow the lifecycle', () => {
  const bot = helpWanted(24, 200 * DAY, { author: { login: 'renovate', __typename: 'Bot' } });
  assert.equal(decide(bot, { now: NOW, repo }), null);
  const deleted = needsInfo(25, 30 * DAY, { author: null });
  const decision = decide(deleted, { now: NOW, repo });
  assert.equal(decision.kind, 'needsInfoClosed');
  assert.match(decision.body, /from the reporter/);
});

test('message bodies start with their marker and say what happens next', () => {
  const closed = needsInfoClosedBody(makeIssue(26));
  assert.ok(closed.startsWith(MARKERS.needsInfoClosed));
  assert.match(closed, /waiting 14 days for more information from @author26/);
  assert.match(closed, /can be reopened once the information is added/);

  const reminder = assignedStaleBody(makeIssue(27, { assignees: ['a', 'b'] }));
  assert.ok(reminder.startsWith(MARKERS.assignedStale));
  assert.match(reminder, /^Hi @a @b, this issue has had no activity for 60 days/m);
  assert.deepEqual(reminder.match(/@[\w-]+/g), ['@a', '@b']);

  const hw = helpWantedClosedBody(makeIssue(28), repo);
  assert.ok(hw.startsWith(MARKERS.helpWantedClosed));
  assert.match(hw, /no activity for 90 days/);
  assert.match(hw, /https:\/\/github\.com\/THU-MAIC\/OpenMAIC\/discussions\/new\?category=ideas/);
});

test('latestMessage only trusts marker comments from the Actions bot', () => {
  const comments = [
    { id: 1, body: MARKERS.assignedStale, created_at: ago(DAY), user: { login: 'x' } },
    botComment(2, `${MARKERS.assignedStale}\nold`, ago(90 * DAY)),
    botComment(3, `${MARKERS.assignedStale}\nnew`, ago(10 * DAY)),
    botComment(4, `${MARKERS.helpWantedClosed}\n`, ago(DAY)),
  ];
  assert.equal(latestMessage(comments, 'assignedStale').id, 3);
  assert.equal(latestMessage([], 'assignedStale'), null);
});

function fakeClient({ issues, comments = {} }) {
  const writes = [];
  return {
    writes,
    async graphql() {
      return {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues },
        },
      };
    },
    async request(route, params) {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: comments[params.issue_number] ?? [] };
      }
      writes.push({ route, params });
      return { data: {} };
    },
  };
}

const routes = {
  comment: 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
  update: 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  close: 'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
  unlabel: 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
};

test('run removes labels, closes, reminds once per idle period and updates in place', async () => {
  const replied = needsInfo(30, 20 * DAY, {
    events: [labeled('status:needs-info', ago(20 * DAY)), comment('author30', ago(DAY))],
  });
  const silent = needsInfo(31, 20 * DAY);
  const stale = assigned(32, 70 * DAY);
  const reminded = assigned(33, 70 * DAY);
  const renamed = assigned(34, 70 * DAY);
  const restarted = assigned(35, 70 * DAY);
  const abandoned = helpWanted(36, 100 * DAY);
  const client = fakeClient({
    issues: [replied, silent, stale, reminded, renamed, restarted, abandoned],
    comments: {
      33: [botComment(501, assignedStaleBody(reminded), ago(5 * DAY))],
      34: [botComment(502, `${MARKERS.assignedStale}\nold assignees`, ago(5 * DAY))],
      // Posted before the current idle period started: a new reminder is due.
      35: [botComment(503, assignedStaleBody(restarted), ago(200 * DAY))],
    },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.number, r.kind, r.action]),
    [
      [30, 'needsInfoReplied', 'remove label'],
      [31, 'needsInfoClosed', 'close'],
      [32, 'assignedStale', 'create'],
      [33, 'assignedStale', 'unchanged'],
      [34, 'assignedStale', 'update'],
      [35, 'assignedStale', 'create'],
      [36, 'helpWantedClosed', 'close'],
    ],
  );
  assert.deepEqual(
    client.writes.map((w) => [w.route, w.params.issue_number ?? w.params.comment_id]),
    [
      [routes.unlabel, 30],
      [routes.comment, 31],
      [routes.close, 31],
      [routes.comment, 32],
      [routes.update, 502],
      [routes.comment, 35],
      [routes.comment, 36],
      [routes.close, 36],
    ],
  );
  assert.equal(client.writes[0].params.name, 'status:needs-info');
  assert.ok(client.writes[1].params.body.startsWith(MARKERS.needsInfoClosed));
  assert.deepEqual(
    [client.writes[2].params.state, client.writes[2].params.state_reason],
    ['closed', 'not_planned'],
  );
  assert.ok(client.writes[6].params.body.startsWith(MARKERS.helpWantedClosed));
  assert.equal(client.writes[7].params.state_reason, 'not_planned');
});

test('a close whose comment was already posted only retries the close', async () => {
  const silent = needsInfo(40, 20 * DAY);
  const client = fakeClient({
    issues: [silent],
    comments: { 40: [botComment(601, needsInfoClosedBody(silent), ago(DAY))] },
  });
  await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    client.writes.map((w) => w.route),
    [routes.close],
  );
});

test('dry runs never write and summaries say so', async () => {
  const client = fakeClient({ issues: [needsInfo(41, 20 * DAY), helpWanted(42, 100 * DAY)] });
  const logs = [];
  const result = await run({
    client,
    repo,
    now: NOW,
    dryRun: true,
    log: (line) => logs.push(line),
  });
  assert.equal(client.writes.length, 0);
  assert.match(logs[0], /#41 needsInfoClosed since .*: would close/);
  const summary = summaryMarkdown(result);
  assert.match(summary, /\(dry run\)/);
  assert.match(
    summary,
    /\| \[#42\]\(.*\) \| `help wanted`, no activity for 90 days \| .* \| would close \|/,
  );
  assert.match(summaryMarkdown({ ...result, results: [] }), /Nothing to do/);
});

test('writes per run are capped and a close is deferred rather than split', async () => {
  const issues = [
    ...Array.from({ length: MAX_WRITES_PER_RUN - 1 }, (_, i) => assigned(100 + i, 70 * DAY)),
    helpWanted(200, 100 * DAY),
    assigned(201, 70 * DAY),
  ];
  const client = fakeClient({ issues });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.equal(client.writes.length, MAX_WRITES_PER_RUN);
  assert.deepEqual(
    result.results.slice(-2).map((r) => [r.number, r.action]),
    [
      [200, 'deferred'],
      [201, 'create'],
    ],
  );
});
