import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSE_MS,
  MARKERS,
  MAX_WRITES_PER_RUN,
  approvalBody,
  approvalSince,
  ciBody,
  closedBody,
  closeDue,
  codexBody,
  codexSince,
  conflictBody,
  conflictSince,
  decide,
  decideCodex,
  failingChecks,
  fetchClient,
  findReminder,
  globalOwners,
  groupRunsBySha,
  isDryRun,
  isEligible,
  isStale,
  lastAuthorActivity,
  listOpenPullRequests,
  newestCodexThreadAt,
  reminderPlan,
  run,
  summaryMarkdown,
  unresolvedCodexThreads,
  writtenAt,
} from './pr-reminders.mjs';

const repo = { owner: 'THU-MAIC', repo: 'OpenMAIC' };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const makePr = (number, extras = {}) => ({
  number,
  url: `https://github.com/THU-MAIC/OpenMAIC/pull/${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  createdAt: ago(10 * DAY),
  baseRefName: 'main',
  headRefName: `feature-${number}`,
  headRefOid: `sha${number}`,
  headRepository: { nameWithOwner: 'contributor/OpenMAIC' },
  author: { login: `author${number}`, __typename: 'User' },
  ...extras,
});
const prRun = (pr, created_at, extras = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  name: 'CI',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_branch: pr.headRefName,
  head_sha: pr.headRefOid,
  head_repository: { full_name: pr.headRepository.nameWithOwner },
  created_at,
  ...extras,
});
const pendingRun = (sha, name, created_at) => ({
  name,
  head_sha: sha,
  status: 'action_required',
  conclusion: null,
  created_at,
});
const botComment = (id, body, created_at = ago(DAY)) => ({
  id,
  body,
  created_at,
  user: { login: 'github-actions[bot]', type: 'Bot' },
});
const thread = (
  createdAt,
  { login = 'chatgpt-codex-connector', type = 'Bot', isResolved = false } = {},
) => ({
  isResolved,
  comments: { nodes: [{ author: { login, __typename: type }, createdAt }] },
});
const withThreads = (threads) => ({ reviewThreads: { nodes: threads } });

test('dry run defaults on for dispatch and off only for scheduled apply mode', () => {
  assert.equal(isDryRun('workflow_dispatch', 'true', 'apply'), true);
  assert.equal(isDryRun('workflow_dispatch', '', 'apply'), true);
  assert.equal(isDryRun('workflow_dispatch', 'false', ''), false);
  assert.equal(isDryRun('schedule', '', ''), true);
  assert.equal(isDryRun('schedule', '', 'dry-run'), true);
  assert.equal(isDryRun('schedule', '', 'apply'), false);
});

test('global owners come from the last catch-all CODEOWNERS rule', () => {
  const text = [
    '# comment',
    '* @org/old-team',
    '/docs/ @org/docs',
    '*   @org/maintainers @someone # trailing',
    'packages/** @org/pkg',
  ].join('\n');
  assert.deepEqual(globalOwners(text), ['@org/maintainers', '@someone']);
  assert.deepEqual(globalOwners('/lib/ @x'), []);
  assert.deepEqual(globalOwners(''), []);
});

test('conflict age starts at the latest pull_request run of the same head repository', () => {
  const pr = makePr(1);
  const runs = [
    prRun(pr, ago(5 * DAY)),
    prRun(pr, ago(3 * DAY)),
    // Same branch name in another fork and a push run do not count.
    prRun(pr, ago(1000), { head_repository: { full_name: 'other/OpenMAIC' } }),
    prRun(pr, ago(1000), { event: 'push' }),
  ];
  assert.equal(conflictSince(pr, runs), ago(3 * DAY));
  assert.equal(conflictSince(pr, []), pr.createdAt);
  const fresh = makePr(2, { createdAt: ago(2 * DAY) });
  assert.equal(conflictSince(fresh, [prRun(fresh, ago(9 * DAY))]), fresh.createdAt);
});

test('approval age is the oldest waiting run on the current head commit', () => {
  const pr = makePr(3);
  const bySha = groupRunsBySha([
    pendingRun(pr.headRefOid, 'CI', ago(2 * DAY)),
    pendingRun(pr.headRefOid, 'Storage', ago(3 * DAY)),
    pendingRun('older-head', 'CI', ago(9 * DAY)),
    {
      ...pendingRun(pr.headRefOid, 'Done', ago(9 * DAY)),
      status: 'completed',
      conclusion: 'success',
    },
  ]);
  assert.equal(approvalSince(pr, bySha), ago(3 * DAY));
  assert.equal(approvalSince(makePr(4), bySha), null);
});

test('stale means strictly more than one day', () => {
  assert.equal(isStale(ago(DAY + 1), NOW), true);
  assert.equal(isStale(ago(DAY), NOW), false);
  assert.equal(isStale(null, NOW), false);
});

test('decide skips drafts, bots, fresh conflicts and prefers the conflict reminder', () => {
  const ctx = (pr, extras = {}) => ({
    now: NOW,
    branchRuns: [],
    runsBySha: groupRunsBySha([pendingRun(pr.headRefOid, 'CI', ago(3 * DAY))]),
    owners: [],
    ...extras,
  });
  const conflicting = makePr(5, { mergeable: 'CONFLICTING' });
  assert.equal(decide(conflicting, ctx(conflicting)).kind, 'conflict');
  assert.equal(decide({ ...conflicting, isDraft: true }, ctx(conflicting)), null);
  const bot = { ...conflicting, author: { login: 'dependabot', __typename: 'Bot' } };
  assert.equal(decide(bot, ctx(bot)), null);
  assert.equal(
    decide(conflicting, ctx(conflicting, { branchRuns: [prRun(conflicting, ago(DAY / 2))] })),
    null,
  );

  const waiting = makePr(6);
  const decision = decide(waiting, ctx(waiting));
  assert.equal(decision.kind, 'approval');
  assert.equal(decision.since, ago(3 * DAY));
  const fresh = makePr(7);
  assert.equal(
    decide(fresh, ctx(fresh, { runsBySha: groupRunsBySha([pendingRun('sha7', 'CI', ago(1000))]) })),
    null,
  );
  assert.equal(decide(makePr(8, { mergeable: 'UNKNOWN' }), ctx(makePr(8))), null);
});

test('comment bodies start with their marker and only mention CODEOWNERS handles', () => {
  const pr = makePr(9);
  const conflict = conflictBody(pr, 'main');
  assert.ok(conflict.startsWith(MARKERS.conflict));
  assert.match(conflict, /@author9/);
  assert.match(conflict, /CI runs again on the next push/);

  const runs = [pendingRun('sha9', 'CI', ago(2 * DAY)), pendingRun('sha9', 'Docs', ago(2 * DAY))];
  const plain = approvalBody(pr, runs, []);
  assert.ok(plain.startsWith(MARKERS.approval));
  assert.match(plain, /^A maintainer with write access/m);
  assert.match(plain, /`CI`, `Docs`/);
  assert.deepEqual(plain.match(/@[\w-]+/g), ['@author9']);
  assert.match(approvalBody(pr, runs, ['@org/maintainers']), /^@org\/maintainers: a maintainer/m);
});

test('findReminder only trusts marker comments from the Actions bot', () => {
  const comments = [
    { id: 1, body: MARKERS.conflict, user: { login: 'someone', type: 'User' } },
    botComment(2, `${MARKERS.approval}\nbody`),
    botComment(3, `${MARKERS.conflict}\nbody`),
  ];
  assert.equal(findReminder(comments, 'conflict').id, 3);
  assert.equal(findReminder(comments, 'approval').id, 2);
  assert.equal(findReminder([], 'conflict'), null);
});

test('listOpenPullRequests re-queries while mergeability is unknown', async () => {
  const states = [
    ['UNKNOWN', 'UNKNOWN'],
    ['CONFLICTING', 'UNKNOWN'],
    ['CONFLICTING', 'MERGEABLE'],
  ];
  let calls = 0;
  const sleeps = [];
  const client = {
    async graphql() {
      const current = states[calls++];
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: current.map((mergeable, i) => makePr(i + 1, { mergeable })),
          },
        },
      };
    },
  };
  const prs = await listOpenPullRequests(client, repo, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.deepEqual(
    prs.map((pr) => pr.mergeable),
    ['CONFLICTING', 'MERGEABLE'],
  );
});

function fakeClient({
  prs,
  pending = [],
  branchRuns = {},
  comments = {},
  codeowners = null,
  activity = {},
}) {
  const writes = [];
  const activityQueries = [];
  return {
    writes,
    activityQueries,
    async graphql(query, variables) {
      if (variables.number) {
        activityQueries.push(variables.number);
        return { repository: { pullRequest: activity[variables.number] ?? {} } };
      }
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs },
        },
      };
    },
    async request(route, params) {
      if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        if (codeowners && params.path === '.github/CODEOWNERS') {
          return { data: { content: Buffer.from(codeowners).toString('base64') } };
        }
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
        if (params.status === 'action_required') return { data: { workflow_runs: pending } };
        return { data: { workflow_runs: branchRuns[params.branch] ?? [] } };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: comments[params.issue_number] ?? [] };
      }
      writes.push({ route, params });
      return { data: {} };
    },
  };
}

test('run creates, updates and leaves reminders alone idempotently', async () => {
  const conflict = makePr(10, { mergeable: 'CONFLICTING' });
  const waiting = makePr(11);
  const unchanged = makePr(12, { mergeable: 'CONFLICTING' });
  const draft = makePr(13, { mergeable: 'CONFLICTING', isDraft: true });
  const pending = [pendingRun('sha11', 'CI', ago(2 * DAY))];
  const client = fakeClient({
    prs: [conflict, waiting, unchanged, draft],
    pending,
    codeowners: '* @org/maintainers\n',
    comments: {
      11: [botComment(501, `${MARKERS.approval}\nold text`)],
      12: [botComment(502, conflictBody(unchanged, 'main'))],
    },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(result.owners, ['@org/maintainers']);
  assert.deepEqual(
    result.results.map((r) => [r.number, r.kind, r.action]),
    [
      [10, 'conflict', 'create'],
      [11, 'approval', 'update'],
      [12, 'conflict', 'unchanged'],
    ],
  );
  assert.deepEqual(
    client.writes.map((w) => [w.route, w.params.issue_number ?? w.params.comment_id]),
    [
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 10],
      ['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', 501],
    ],
  );
  assert.match(client.writes[1].params.body, /@org\/maintainers/);
});

test('dry runs never write and summaries say so', async () => {
  const client = fakeClient({ prs: [makePr(20, { mergeable: 'CONFLICTING' })] });
  const result = await run({ client, repo, now: NOW, dryRun: true, log: () => {} });
  assert.equal(client.writes.length, 0);
  assert.equal(result.results[0].action, 'create');
  const summary = summaryMarkdown(result);
  assert.match(summary, /\(dry run\)/);
  assert.match(summary, /\| \[#20\]\(.*\) \| merge conflict \| .* \| would create \|/);
  assert.match(summaryMarkdown({ ...result, results: [] }), /Nothing is stuck/);
});

test('writes per run are capped', async () => {
  const prs = Array.from({ length: MAX_WRITES_PER_RUN + 3 }, (_, i) =>
    makePr(100 + i, { mergeable: 'CONFLICTING' }),
  );
  const client = fakeClient({ prs });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.equal(client.writes.length, MAX_WRITES_PER_RUN);
  assert.equal(result.results.filter((r) => r.action === 'deferred').length, 3);
});

test('the local client refuses writes', async () => {
  const client = fetchClient('token', 'http://127.0.0.1:9');
  await assert.rejects(
    client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', repo),
    /read-only/,
  );
});

test('only unresolved Codex threads count, outdated ones included', () => {
  const pr = makePr(30, {
    ...withThreads([
      thread(ago(3 * DAY)),
      thread(ago(5 * DAY), { isResolved: true }),
      thread(ago(6 * DAY), { login: 'someone' }),
      thread(ago(2 * DAY), { login: 'chatgpt-codex-connector[bot]' }),
      { ...thread(ago(4 * DAY)), isOutdated: true },
    ]),
  });
  // GraphQL reports the app as `chatgpt-codex-connector`; the REST-style
  // `[bot]` login is not the GraphQL actor and does not count.
  assert.equal(unresolvedCodexThreads(pr).length, 2);
  assert.equal(codexSince(pr), ago(4 * DAY));
  assert.equal(codexSince(makePr(31)), null);
  assert.equal(codexSince(makePr(32, withThreads([thread(ago(DAY), { isResolved: true })]))), null);
});

test('decideCodex waits a day and skips drafts, bots and blocked pull requests', () => {
  const pr = makePr(33, withThreads([thread(ago(2 * DAY)), thread(ago(DAY / 2))]));
  const decision = decideCodex(pr, { now: NOW });
  assert.equal(decision.kind, 'codex');
  assert.equal(decision.count, 2);
  assert.equal(decision.since, ago(2 * DAY));
  assert.equal(decideCodex(makePr(34, withThreads([thread(ago(DAY / 2))])), { now: NOW }), null);
  assert.equal(decideCodex({ ...pr, isDraft: true }, { now: NOW }), null);
  assert.equal(
    decideCodex({ ...pr, author: { login: 'renovate', __typename: 'Bot' } }, { now: NOW }),
    null,
  );
  const blocked = { ...pr, labels: { nodes: [{ name: 'bug' }, { name: 'status:blocked' }] } };
  assert.equal(decideCodex(blocked, { now: NOW }), null);
});

test('codex comment bodies mention the author, the count and the close window', () => {
  const pr = makePr(35);
  const body = codexBody(pr, 2);
  assert.ok(body.startsWith(MARKERS.codex));
  assert.match(body, /Hi @author35, 2 Codex review threads are still unresolved/);
  assert.match(body, /within 7 days after this reminder/);
  assert.match(codexBody(pr, 1), /1 Codex review thread is still unresolved/);
  const closed = closedBody(pr, [{ kind: 'codex', count: 1 }]);
  assert.ok(closed.startsWith(MARKERS.closed));
  assert.match(closed, /@author35, closing this pull request: .* for 7 days/);
  assert.match(closed, /^- 1 Codex review thread is still unresolved\.$/m);
  assert.match(closed, /reopen/);
});

test('the close window restarts at author activity, pushes and newer threads', () => {
  const pr = makePr(36);
  const activity = {
    commits: { nodes: [{ commit: { committedDate: ago(9 * DAY) } }] },
    timelineItems: { nodes: [{ createdAt: ago(8 * DAY) }] },
    reviews: {
      nodes: [
        { author: { login: 'author36' }, submittedAt: ago(5 * DAY) },
        { author: { login: 'maintainer' }, submittedAt: ago(1000) },
        { author: { login: 'author36' }, submittedAt: null },
      ],
    },
  };
  const comments = [
    { user: { login: 'maintainer' }, created_at: ago(1000) },
    { user: { login: 'author36' }, created_at: ago(6 * DAY) },
  ];
  assert.equal(lastAuthorActivity(pr, activity, comments), ago(5 * DAY));
  assert.equal(lastAuthorActivity(pr, {}, []), null);

  const due = (extras) =>
    closeDue({
      reminderAt: ago(8 * DAY),
      newestThreadAt: ago(10 * DAY),
      lastActivity: null,
      now: NOW,
      ...extras,
    });
  assert.equal(due({}), true);
  assert.equal(due({ reminderAt: ago(CLOSE_MS) }), false);
  assert.equal(due({ lastActivity: ago(5 * DAY) }), false);
  assert.equal(due({ newestThreadAt: ago(2 * DAY) }), false);

  const mixed = withThreads([thread(ago(10 * DAY)), thread(ago(2 * DAY))]);
  assert.equal(newestCodexThreadAt(mixed), ago(2 * DAY));
  assert.equal(newestCodexThreadAt(withThreads([])), null);
});

test('run reminds, closes after 7 quiet days and spares active authors', async () => {
  const threads = withThreads([thread(ago(12 * DAY)), thread(ago(11 * DAY))]);
  const fresh = makePr(40, withThreads([thread(ago(DAY / 2))]));
  const remind = makePr(41, threads);
  const waiting = makePr(42, threads);
  const quiet = makePr(43, threads);
  const active = makePr(44, threads);
  const resolved = makePr(45, withThreads([thread(ago(12 * DAY), { isResolved: true })]));
  const blocked = makePr(46, { ...threads, labels: { nodes: [{ name: 'status:blocked' }] } });
  const draft = makePr(47, { ...threads, isDraft: true });
  const conflictAndCodex = makePr(48, { ...threads, mergeable: 'CONFLICTING' });
  const reminder = (id, pr, days) => botComment(id, codexBody(pr, 2), ago(days * DAY));
  const client = fakeClient({
    prs: [fresh, remind, waiting, quiet, active, resolved, blocked, draft, conflictAndCodex],
    comments: {
      42: [reminder(601, waiting, 3)],
      43: [reminder(602, quiet, 8), { user: { login: 'author43' }, created_at: ago(9 * DAY) }],
      44: [reminder(603, active, 8)],
      45: [reminder(604, resolved, 9)],
      46: [reminder(605, blocked, 9)],
    },
    activity: {
      43: { commits: { nodes: [{ commit: { committedDate: ago(10 * DAY) } }] } },
      44: { reviews: { nodes: [{ author: { login: 'author44' }, submittedAt: ago(2 * DAY) }] } },
    },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.number, r.kind, r.action]),
    [
      [41, 'codex', 'create'],
      [42, 'codex', 'unchanged'],
      [43, 'codex', 'close'],
      [44, 'codex', 'unchanged'],
      [48, 'conflict', 'create'],
      [48, 'codex', 'create'],
    ],
  );
  assert.deepEqual(client.activityQueries, [43, 44]);
  assert.deepEqual(
    client.writes.map((w) => [w.route, w.params.issue_number ?? w.params.pull_number]),
    [
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 41],
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 43],
      ['PATCH /repos/{owner}/{repo}/pulls/{pull_number}', 43],
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 48],
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 48],
    ],
  );
  assert.ok(client.writes[1].params.body.startsWith(MARKERS.closed));
  assert.equal(client.writes[2].params.state, 'closed');
});

test('thread replies, pushes and unread thread pages keep a pull request open', async () => {
  const threads = withThreads([thread(ago(12 * DAY))]);
  const replied = makePr(50, threads);
  const pushed = makePr(51, threads);
  const paged = makePr(52, {
    reviewThreads: { pageInfo: { hasNextPage: true }, nodes: threads.reviewThreads.nodes },
  });
  const reminder = (id, pr) => botComment(id, codexBody(pr, 1), ago(8 * DAY));
  const client = fakeClient({
    prs: [replied, pushed, paged],
    comments: {
      50: [reminder(701, replied)],
      51: [reminder(702, pushed)],
      52: [reminder(703, paged)],
    },
    activity: {
      50: {
        reviewThreads: {
          nodes: [
            { comments: { nodes: [{ author: { login: 'author50' }, createdAt: ago(DAY) }] } },
          ],
        },
      },
      51: {
        commits: {
          nodes: [
            {
              commit: {
                committedDate: ago(20 * DAY),
                checkSuites: { nodes: [{ createdAt: ago(2 * DAY) }] },
              },
            },
          ],
        },
      },
    },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.number, r.action]),
    [
      [50, 'unchanged'],
      [51, 'unchanged'],
      [52, 'unchanged'],
    ],
  );
  assert.deepEqual(client.activityQueries, [50, 51]);
  assert.deepEqual(client.writes, []);
});

test('marking ready or removing status:blocked restarts the close window', () => {
  const pr = makePr(61);
  const at = (nodes) => lastAuthorActivity(pr, { timelineItems: { nodes } }, []);
  assert.equal(at([{ createdAt: ago(DAY) }]), ago(DAY));
  assert.equal(at([{ createdAt: ago(DAY), label: { name: 'status:blocked' } }]), ago(DAY));
  assert.equal(at([{ createdAt: ago(DAY), label: { name: 'bug' } }]), null);
});

test('a new episode of Codex threads gets a fresh reminder and window', async () => {
  const pr = makePr(62, withThreads([thread(ago(2 * DAY))]));
  const client = fakeClient({
    prs: [pr],
    comments: { 62: [botComment(901, codexBody(pr, 1), ago(20 * DAY))] },
    activity: { 62: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => r.action),
    ['create'],
  );
  assert.deepEqual(client.activityQueries, []);
  assert.deepEqual(
    client.writes.map((w) => w.route),
    ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments'],
  );
});

test('only the Codex bot itself opens Codex threads', () => {
  const pr = withThreads([
    thread(ago(2 * DAY), { login: 'chatgpt-codex-connector', type: 'User' }),
    thread(ago(2 * DAY), { login: 'chatgpt-codex-connector-fake' }),
    thread(ago(2 * DAY)),
  ]);
  assert.equal(unresolvedCodexThreads(pr).length, 1);
});

test('pull requests from deleted accounts are skipped', () => {
  assert.equal(isEligible({ isDraft: false, author: null }), false);
});

test('a close whose comment was already posted only retries the close', async () => {
  const pr = makePr(60, withThreads([thread(ago(12 * DAY))]));
  const client = fakeClient({
    prs: [pr],
    comments: {
      60: [
        botComment(801, codexBody(pr, 1), ago(9 * DAY)),
        // Posted by an earlier version under the old marker.
        botComment(802, `${MARKERS.codexClosed}\nold closing text`, ago(DAY)),
      ],
    },
    activity: { 60: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => r.action),
    ['close'],
  );
  assert.deepEqual(
    client.writes.map((w) => w.route),
    ['PATCH /repos/{owner}/{repo}/pulls/{pull_number}'],
  );
});

test('dry runs never close and report what they would do', async () => {
  const pr = makePr(50, withThreads([thread(ago(12 * DAY))]));
  const client = fakeClient({
    prs: [pr],
    comments: { 50: [botComment(701, codexBody(pr, 1), ago(8 * DAY))] },
  });
  const logs = [];
  const result = await run({
    client,
    repo,
    now: NOW,
    dryRun: true,
    log: (line) => logs.push(line),
  });
  assert.equal(client.writes.length, 0);
  assert.equal(result.results[0].action, 'close');
  assert.match(logs[0], /#50 codex since .*: would close/);
  assert.match(summaryMarkdown(result), /\| unresolved Codex threads \| .* \| would close \|/);
});

test('a close is deferred rather than split when the write cap is reached', async () => {
  const conflicts = Array.from({ length: MAX_WRITES_PER_RUN - 1 }, (_, i) =>
    makePr(200 + i, { mergeable: 'CONFLICTING' }),
  );
  const pr = makePr(300, withThreads([thread(ago(12 * DAY))]));
  const client = fakeClient({
    prs: [...conflicts, pr],
    comments: { 300: [botComment(801, codexBody(pr, 1), ago(8 * DAY))] },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.equal(client.writes.length, MAX_WRITES_PER_RUN - 1);
  assert.equal(result.results.at(-1).action, 'deferred');
});

const checkRun = (name, conclusion, completedAt = ago(2 * DAY)) => ({
  __typename: 'CheckRun',
  name,
  conclusion,
  completedAt,
});
const statusContext = (context, state, createdAt = ago(2 * DAY)) => ({
  __typename: 'StatusContext',
  context,
  state,
  createdAt,
});
const withChecks = (nodes) => ({
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
});
const blockedLabel = { labels: { nodes: [{ name: 'status:blocked' }] } };
const decideCtx = (extras = {}) => ({
  now: NOW,
  branchRuns: [],
  runsBySha: new Map(),
  owners: [],
  ...extras,
});

test('failingChecks counts failures, timeouts, startup failures and failed statuses', () => {
  const pr = makePr(400, {
    ...withChecks([
      checkRun('lint', 'FAILURE', ago(2 * DAY)),
      checkRun('test', 'TIMED_OUT', ago(3 * DAY)),
      checkRun('build', 'STARTUP_FAILURE', ago(DAY)),
      checkRun('lint', 'FAILURE', ago(4 * DAY)),
      statusContext('ci/legacy', 'FAILURE', ago(5 * DAY)),
      statusContext('ci/deploy', 'ERROR', ago(DAY)),
      checkRun('cancelled', 'CANCELLED', ago(9 * DAY)),
      checkRun('neutral', 'NEUTRAL', ago(9 * DAY)),
      checkRun('skipped', 'SKIPPED', ago(9 * DAY)),
      checkRun('approval', 'ACTION_REQUIRED', ago(9 * DAY)),
      checkRun('ok', 'SUCCESS', ago(9 * DAY)),
      statusContext('ci/pending', 'PENDING', ago(9 * DAY)),
      statusContext('ci/ok', 'SUCCESS', ago(9 * DAY)),
    ]),
  });
  assert.deepEqual(failingChecks(pr), {
    names: ['build', 'ci/deploy', 'ci/legacy', 'lint', 'test'],
    since: ago(5 * DAY),
  });
  const passing = makePr(401, {
    ...withChecks(
      ['CANCELLED', 'NEUTRAL', 'SKIPPED', 'ACTION_REQUIRED', 'SUCCESS'].map((c) => checkRun(c, c)),
    ),
  });
  assert.equal(failingChecks(passing), null);
  assert.equal(failingChecks(makePr(402)), null);
  // A failure without a timestamp is not known to be stale yet.
  const undated = makePr(403, withChecks([checkRun('lint', 'FAILURE', null)]));
  assert.deepEqual(failingChecks(undated), { names: ['lint'], since: null });
  assert.equal(decide(undated, decideCtx()), null);
});

test('decide prefers conflict over approval over failing CI', () => {
  const failing = withChecks([checkRun('lint', 'FAILURE', ago(3 * DAY))]);
  const pending = (pr) => groupRunsBySha([pendingRun(pr.headRefOid, 'CI', ago(3 * DAY))]);
  const all = makePr(410, { ...failing, mergeable: 'CONFLICTING' });
  assert.equal(decide(all, decideCtx({ runsBySha: pending(all) })).kind, 'conflict');
  const approvalAndCi = makePr(411, failing);
  assert.equal(
    decide(approvalAndCi, decideCtx({ runsBySha: pending(approvalAndCi) })).kind,
    'approval',
  );
  const ci = decide(makePr(412, failing), decideCtx());
  assert.equal(ci.kind, 'ci');
  assert.equal(ci.since, ago(3 * DAY));
  assert.deepEqual(ci.names, ['lint']);
  assert.ok(ci.body.startsWith(MARKERS.ci));
  assert.match(ci.body, /`lint`/);
});

test('failing CI is not stale within a day', () => {
  const fresh = makePr(413, withChecks([checkRun('lint', 'FAILURE', ago(DAY))]));
  assert.equal(decide(fresh, decideCtx()), null);
  const stale = makePr(414, withChecks([checkRun('lint', 'FAILURE', ago(DAY + 1))]));
  assert.equal(decide(stale, decideCtx()).kind, 'ci');
});

test('blocked pull requests get reminders without the close sentence', () => {
  const close = /will be closed automatically/;
  const pr = makePr(415);
  assert.match(conflictBody(pr, 'main'), close);
  assert.match(ciBody(pr, ['lint']), close);
  assert.doesNotMatch(conflictBody(pr, 'main', { close: false }), close);
  assert.doesNotMatch(ciBody(pr, ['lint'], { close: false }), close);
  const conflicting = makePr(416, { ...blockedLabel, mergeable: 'CONFLICTING' });
  assert.doesNotMatch(decide(conflicting, decideCtx()).body, close);
  const failing = makePr(417, {
    ...blockedLabel,
    ...withChecks([checkRun('lint', 'FAILURE', ago(3 * DAY))]),
  });
  assert.doesNotMatch(decide(failing, decideCtx()).body, close);
});

test('reminderPlan only starts a window from a current-wording reminder of this episode', () => {
  const pr = makePr(420, { mergeable: 'CONFLICTING' });
  const decision = decide(pr, decideCtx());
  const ciPr = makePr(421, withChecks([checkRun('lint', 'FAILURE', ago(5 * DAY))]));
  const ciDecision = decide(ciPr, decideCtx());

  // Old wording never announced the close: no window, so it gets updated.
  for (const [p, d, marker] of [
    [pr, decision, MARKERS.conflict],
    [ciPr, ciDecision, MARKERS.ci],
  ]) {
    const old = botComment(1, `${marker}\nold wording`, ago(4 * DAY));
    assert.deepEqual(reminderPlan(p, d, [old]), { existing: old, window: null });
  }

  // Current wording: the window starts when it was last written.
  const current = {
    ...botComment(2, decision.body, ago(9 * DAY)),
    updated_at: ago(3 * DAY),
  };
  assert.equal(writtenAt(current), ago(3 * DAY));
  assert.deepEqual(reminderPlan(pr, decision, [current]), {
    existing: current,
    window: { reminderAt: ago(3 * DAY) },
  });

  // Blocked: never a window.
  const blocked = { ...pr, ...blockedLabel };
  const blockedDecision = decide(blocked, decideCtx());
  const blockedReminder = botComment(3, blockedDecision.body, ago(3 * DAY));
  assert.equal(reminderPlan(blocked, blockedDecision, [blockedReminder]).window, null);

  // Written before the episode began: belongs to an earlier one.
  const earlier = botComment(4, ciDecision.body, ago(6 * DAY));
  assert.deepEqual(reminderPlan(ciPr, ciDecision, [earlier]), { existing: null, window: null });
});

const conflictCodexPr = (number) =>
  makePr(number, { ...withThreads([thread(ago(12 * DAY))]), mergeable: 'CONFLICTING' });

test('run closes a quiet conflicting pull request once, listing every due reason', async () => {
  const pr = conflictCodexPr(430);
  const client = fakeClient({
    prs: [pr],
    comments: {
      430: [
        botComment(1001, conflictBody(pr, 'main'), ago(8 * DAY)),
        botComment(1002, codexBody(pr, 1), ago(8 * DAY)),
      ],
    },
    activity: { 430: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [
      ['conflict', 'close'],
      ['codex', 'close'],
    ],
  );
  assert.deepEqual(client.activityQueries, [430]);
  assert.deepEqual(
    client.writes.map((w) => w.route),
    [
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
    ],
  );
  const body = client.writes[0].params.body;
  assert.ok(body.startsWith(MARKERS.closed));
  assert.match(body, /^- It has merge conflicts with `main`\.$/m);
  assert.match(body, /^- 1 Codex review thread is still unresolved\.$/m);
  assert.equal(client.writes[1].params.state, 'closed');
});

test('run closes a pull request whose CI keeps failing', async () => {
  const pr = makePr(431, withChecks([checkRun('lint', 'FAILURE', ago(12 * DAY))]));
  const client = fakeClient({
    prs: [pr],
    comments: { 431: [botComment(1003, ciBody(pr, ['lint']), ago(8 * DAY))] },
    activity: { 431: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [['ci', 'close']],
  );
  assert.match(client.writes[0].params.body, /^- CI is failing: `lint`\.$/m);
});

test('author activity after a conflict reminder keeps the pull request open', async () => {
  const pr = makePr(432, { mergeable: 'CONFLICTING' });
  const client = fakeClient({
    prs: [pr],
    comments: {
      432: [
        botComment(1004, conflictBody(pr, 'main'), ago(8 * DAY)),
        { user: { login: 'author432' }, created_at: ago(2 * DAY) },
      ],
    },
    activity: { 432: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [['conflict', 'unchanged']],
  );
  assert.deepEqual(client.activityQueries, [432]);
  assert.deepEqual(client.writes, []);
});

test('an old-wording conflict reminder is updated, not closed', async () => {
  const pr = makePr(433, { mergeable: 'CONFLICTING', createdAt: ago(40 * DAY) });
  const client = fakeClient({
    prs: [pr],
    comments: { 433: [botComment(1005, `${MARKERS.conflict}\nold wording`, ago(30 * DAY))] },
    activity: { 433: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [['conflict', 'update']],
  );
  assert.deepEqual(client.activityQueries, []);
  assert.deepEqual(
    client.writes.map((w) => [w.route, w.params.comment_id]),
    [['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', 1005]],
  );
  assert.equal(client.writes[0].params.body, conflictBody(pr, 'main'));
});

test('a retried close posts no second closing comment, under either marker', async () => {
  for (const marker of [MARKERS.closed, MARKERS.codexClosed]) {
    const pr = conflictCodexPr(434);
    const client = fakeClient({
      prs: [pr],
      comments: {
        434: [
          botComment(1006, conflictBody(pr, 'main'), ago(9 * DAY)),
          botComment(1007, codexBody(pr, 1), ago(9 * DAY)),
          botComment(1008, `${marker}\nclosing text`, ago(DAY)),
        ],
      },
      activity: { 434: {} },
    });
    const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
    assert.deepEqual(
      result.results.map((r) => r.action),
      ['close', 'close'],
      marker,
    );
    assert.deepEqual(
      client.writes.map((w) => w.route),
      ['PATCH /repos/{owner}/{repo}/pulls/{pull_number}'],
      marker,
    );
  }
});

test('waiting for approval never closes', async () => {
  const pr = makePr(435);
  const pending = [pendingRun(pr.headRefOid, 'CI', ago(40 * DAY))];
  const body = approvalBody(pr, pending, []);
  const client = fakeClient({
    prs: [pr],
    pending,
    comments: { 435: [botComment(1009, body, ago(30 * DAY))] },
    activity: { 435: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [['approval', 'unchanged']],
  );
  assert.deepEqual(client.activityQueries, []);
  assert.deepEqual(client.writes, []);
});

test('a push to a conflicting pull request restarts every close window', async () => {
  // GitHub runs no checks on a conflicting pull request and the pushed commits
  // may be old, so the new head is the only trace of the push.
  const pr = conflictCodexPr(440);
  const before = { ...pr, headRefOid: 'oldsha' };
  const client = fakeClient({
    prs: [pr],
    comments: {
      440: [
        botComment(1101, conflictBody(before, 'main'), ago(8 * DAY)),
        botComment(1102, codexBody(before, 1), ago(8 * DAY)),
      ],
    },
    activity: { 440: {} },
  });
  const result = await run({ client, repo, now: NOW, dryRun: false, log: () => {} });
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.action]),
    [
      ['conflict', 'update'],
      ['codex', 'update'],
    ],
  );
  assert.deepEqual(
    client.writes.map((w) => [w.route, w.params.comment_id]),
    [
      ['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', 1101],
      ['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', 1102],
    ],
  );
  assert.match(client.writes[0].params.body, /<!-- head: sha440 -->/);
});
