import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKER,
  TITLE,
  age,
  awaitsProviderDecision,
  classify,
  headPushedAt,
  isBlocked,
  isDryRun,
  isReadyForReview,
  isUntriaged,
  needsInfoReplied,
  renderDigest,
  run,
  safeTitle,
  upsertIssue,
} from './maintainer-digest.mjs';

const repo = { owner: 'THU-MAIC', repo: 'OpenMAIC' };
const repoName = 'THU-MAIC/OpenMAIC';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const makeIssue = (number, { labels = [], assignees = [], events = [], ...extras } = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/THU-MAIC/OpenMAIC/issues/${number}`,
  createdAt: ago((100 - number) * DAY),
  isPinned: false,
  author: { login: `author${number}`, __typename: 'User' },
  assignees: { nodes: assignees.map((login) => ({ login })) },
  labels: { nodes: labels.map((name) => ({ name })) },
  closedByPullRequestsReferences: { nodes: [] },
  timelineItems: { nodes: events },
  ...extras,
});
const labeled = (name, at) => ({
  __typename: 'LabeledEvent',
  createdAt: at,
  label: { name },
  actor: { login: 'maintainer' },
});
const comment = (login, at) => ({
  __typename: 'IssueComment',
  createdAt: at,
  author: { login, __typename: 'User' },
});
const review = (
  submittedAt,
  { login = 'maintainer', association = 'MEMBER', type = 'User' } = {},
) => ({
  submittedAt,
  authorAssociation: association,
  author: { login, __typename: type },
});
const codexThread = (isResolved) => ({
  isResolved,
  comments: {
    nodes: [
      { author: { login: 'chatgpt-codex-connector', __typename: 'Bot' }, createdAt: ago(DAY) },
    ],
  },
});
const makePr = (number, { reviews = [], threads = [], labels = [], ...extras } = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/THU-MAIC/OpenMAIC/pull/${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  createdAt: ago(10 * DAY),
  authorAssociation: 'CONTRIBUTOR',
  author: { login: `author${number}`, __typename: 'User' },
  labels: { nodes: labels.map((name) => ({ name })) },
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
  reviews: { nodes: reviews },
  commits: {
    nodes: [
      {
        commit: {
          committedDate: ago(9 * DAY),
          statusCheckRollup: { state: 'SUCCESS' },
          checkSuites: { nodes: [{ createdAt: ago(3 * DAY) }, { createdAt: ago(2 * DAY) }] },
        },
      },
    ],
  },
  ...extras,
});

test('dry run is the default unless the repository variable says apply', () => {
  assert.equal(isDryRun('schedule', '', ''), true);
  assert.equal(isDryRun('schedule', '', 'apply'), false);
  assert.equal(isDryRun('workflow_dispatch', '', 'apply'), true);
});

test('untriaged means no assignee, no status, no help wanted and no open PR', () => {
  assert.equal(isUntriaged(makeIssue(1, { labels: ['bug', 'area:editor'] }), repoName), true);
  for (const label of ['status:needs-info', 'status:blocked', 'help wanted']) {
    assert.equal(isUntriaged(makeIssue(2, { labels: [label] }), repoName), false, label);
  }
  assert.equal(isUntriaged(makeIssue(3, { assignees: ['owner1'] }), repoName), false);
  const linked = makeIssue(4, {
    closedByPullRequestsReferences: { nodes: [{ number: 9, state: 'OPEN', updatedAt: ago(DAY) }] },
  });
  assert.equal(isUntriaged(linked, repoName), false);
  const bot = makeIssue(5, { author: { login: 'github-actions', __typename: 'Bot' } });
  assert.equal(isUntriaged(bot, repoName), false);
});

test('blocked and replied-to needs-info issues are listed', () => {
  assert.equal(isBlocked(makeIssue(6, { labels: ['status:blocked'] })), true);
  assert.equal(isBlocked(makeIssue(7)), false);
  const replied = makeIssue(8, {
    labels: ['status:needs-info'],
    events: [labeled('status:needs-info', ago(5 * DAY)), comment('author8', ago(DAY))],
  });
  const waiting = makeIssue(9, {
    labels: ['status:needs-info'],
    events: [comment('author9', ago(6 * DAY)), labeled('status:needs-info', ago(5 * DAY))],
  });
  assert.equal(needsInfoReplied(replied), true);
  assert.equal(needsInfoReplied(waiting), false);
});

test('the latest push is the earliest check suite on the head commit', () => {
  assert.equal(headPushedAt(makePr(10)), ago(3 * DAY));
  const noSuites = makePr(11);
  noSuites.commits.nodes[0].commit.checkSuites.nodes = [];
  assert.equal(headPushedAt(noSuites), ago(9 * DAY));
  assert.equal(headPushedAt(makePr(12, { commits: { nodes: [] } })), null);
});

test('ready for review needs green CI, no conflicts, no open Codex threads and no review since the push', () => {
  assert.equal(isReadyForReview(makePr(20)), true);
  assert.equal(isReadyForReview(makePr(21, { isDraft: true })), false);
  assert.equal(isReadyForReview(makePr(22, { mergeable: 'CONFLICTING' })), false);
  assert.equal(isReadyForReview(makePr(23, { mergeable: 'UNKNOWN' })), false);
  const red = makePr(24);
  red.commits.nodes[0].commit.statusCheckRollup.state = 'FAILURE';
  assert.equal(isReadyForReview(red), false);
  const noChecks = makePr(25);
  noChecks.commits.nodes[0].commit.statusCheckRollup = null;
  assert.equal(isReadyForReview(noChecks), false);
  assert.equal(isReadyForReview(makePr(26, { threads: [codexThread(false)] })), false);
  assert.equal(isReadyForReview(makePr(27, { threads: [codexThread(true)] })), true);
  const paged = makePr(28);
  paged.reviewThreads.pageInfo.hasNextPage = true;
  assert.equal(isReadyForReview(paged), false);
  // A maintainer review after the latest push means it is not waiting.
  assert.equal(isReadyForReview(makePr(29, { reviews: [review(ago(DAY))] })), false);
  // Older maintainer reviews, bot reviews, outside reviews and self-reviews do not count.
  const notCounted = [
    review(ago(5 * DAY)),
    review(ago(DAY), { login: 'chatgpt-codex-connector', association: 'NONE', type: 'Bot' }),
    review(ago(DAY), { login: 'passer-by', association: 'CONTRIBUTOR' }),
    review(ago(DAY), { login: 'author30', association: 'COLLABORATOR' }),
  ];
  assert.equal(isReadyForReview(makePr(30, { reviews: notCounted })), true);
});

test('provider PRs from contributors await a decision until a maintainer reviews', () => {
  const labels = ['area:providers'];
  assert.equal(awaitsProviderDecision(makePr(40, { labels })), true);
  assert.equal(awaitsProviderDecision(makePr(41)), false);
  assert.equal(awaitsProviderDecision(makePr(42, { labels, isDraft: true })), false);
  assert.equal(awaitsProviderDecision(makePr(43, { labels, authorAssociation: 'MEMBER' })), false);
  assert.equal(
    awaitsProviderDecision(makePr(44, { labels, reviews: [review(ago(9 * DAY))] })),
    false,
  );
  assert.equal(
    awaitsProviderDecision(
      makePr(45, { labels, reviews: [review(ago(DAY), { association: 'NONE', type: 'Bot' })] }),
    ),
    true,
  );
});

test('classify sorts each section oldest first', () => {
  const sections = classify({
    issues: [makeIssue(60), makeIssue(50), makeIssue(55, { labels: ['status:blocked'] })],
    prs: [makePr(70, { createdAt: ago(DAY), labels: ['area:providers'] }), makePr(71)],
    repoName,
  });
  assert.deepEqual(
    sections.untriaged.map((i) => i.number),
    [50, 60],
  );
  assert.deepEqual(
    sections.blocked.map((i) => i.number),
    [55],
  );
  assert.deepEqual(
    sections.ready.map((p) => p.number),
    [70, 71],
  );
  assert.deepEqual(
    sections.providers.map((p) => p.number),
    [70],
  );
});

test('titles cannot mention people, reference issues or inject markup', () => {
  const title = safeTitle('[Bug] @someone see #12 <img src=x> | `x`\nnext');
  assert.ok(!/@[a-z]/.test(title));
  assert.ok(!/#\d/.test(title));
  assert.match(title, /\\<img/);
  assert.ok(!title.includes('\n'));
  assert.equal(age(ago(3 * DAY), NOW), '3 days');
  assert.equal(age(ago(DAY), NOW), '1 day');
  assert.equal(age(ago(DAY / 2), NOW), 'under a day');
});

test('the digest starts with the marker and lists every section with counts', () => {
  const sections = classify({
    issues: [makeIssue(80, { title: 'Crash @here' })],
    prs: [makePr(81, { labels: ['area:providers'] })],
    repoName,
  });
  const body = renderDigest({ repoName, now: NOW, scanned: { issues: 1, prs: 1 }, sections });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, new RegExp(`^# ${TITLE}$`, 'm'));
  assert.match(body, /^## Untriaged issues \(1\)$/m);
  assert.match(body, /\[#80\]\(.*\/issues\/80\) Crash @​here: opened 20 days ago/);
  assert.match(body, /^## Blocked on maintainers \(0\)$/m);
  assert.match(body, /^## Needs info, author replied \(0\)$/m);
  assert.match(body, /^## Pull requests ready for review \(1\)$/m);
  assert.match(body, /^## Provider pull requests awaiting a decision \(1\)$/m);
  assert.match(body, /#81\]\(.*\) PR 81: opened 10 days ago \(past the 7-day decision window\)/);
  assert.match(body, /issues\?q=is%3Aissue%20is%3Aopen%20label%3A%22status%3Ablocked%22/);
});

function fakeClient({ issues = [], prs = [], existing = [] }) {
  const writes = [];
  return {
    writes,
    async graphql(query) {
      if (query.includes('pullRequests(')) {
        return {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs },
          },
        };
      }
      return {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues },
        },
      };
    },
    async request(route, params) {
      if (route === 'GET /repos/{owner}/{repo}/issues') return { data: existing };
      writes.push({ route, params });
      return { data: { number: 999, html_url: 'https://github.com/THU-MAIC/OpenMAIC/issues/999' } };
    },
  };
}

test('dry runs never write; apply updates the marked issue in place or creates one', async () => {
  const dry = fakeClient({ issues: [makeIssue(90)] });
  const result = await run({ client: dry, repo, now: NOW, dryRun: true, log: () => {} });
  assert.equal(dry.writes.length, 0);
  assert.equal(result.issue, null);
  assert.equal(result.sections.untriaged.length, 1);

  const existing = [
    { number: 5, body: 'unrelated bot issue' },
    { number: 6, body: `${MARKER}\nold`, pull_request: {} },
    {
      number: 7,
      body: `${MARKER}\nold`,
      html_url: 'https://github.com/THU-MAIC/OpenMAIC/issues/7',
    },
  ];
  const update = fakeClient({ existing });
  assert.deepEqual(await upsertIssue(update, repo, 'body'), {
    action: 'updated',
    number: 7,
    url: 'https://github.com/THU-MAIC/OpenMAIC/issues/7',
  });
  assert.deepEqual(update.writes, [
    {
      route: 'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
      params: { ...repo, issue_number: 7, title: TITLE, body: 'body' },
    },
  ]);

  const create = fakeClient({});
  assert.equal((await upsertIssue(create, repo, 'body')).action, 'created');
  assert.deepEqual(create.writes[0].route, 'POST /repos/{owner}/{repo}/issues');
  assert.equal(create.writes[0].params.title, TITLE);
});

test('only untriaged issues from the last 30 days are linked', async () => {
  const { recentUntriaged, UNTRIAGED_LIST_DAYS } = await import('./maintainer-digest.mjs');
  const now = Date.parse('2026-11-17T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const issues = [
    { number: 1, createdAt: new Date(now - (UNTRIAGED_LIST_DAYS + 1) * day).toISOString() },
    { number: 2, createdAt: new Date(now - 2 * day).toISOString() },
  ];
  assert.deepEqual(
    recentUntriaged(issues, now).map((issue) => issue.number),
    [2],
  );
});
