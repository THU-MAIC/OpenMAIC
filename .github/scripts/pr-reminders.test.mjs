import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_CLOSE_MS,
  MARKERS,
  MAX_WRITES_PER_RUN,
  approvalBody,
  approvalSince,
  codexBody,
  codexClosedBody,
  codexCloseDue,
  isEligible,
  newestCodexThreadAt,
  codexSince,
  conflictBody,
  conflictSince,
  decide,
  decideCodex,
  fetchClient,
  findReminder,
  globalOwners,
  groupRunsBySha,
  isDryRun,
  isStale,
  lastAuthorActivity,
  listOpenPullRequests,
  run,
  summaryMarkdown,
  unresolvedCodexThreads,
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
const thread = (createdAt, { login = 'chatgpt-codex-connector', isResolved = false } = {}) => ({
  isResolved,
  comments: { nodes: [{ author: { login }, createdAt }] },
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
  assert.equal(unresolvedCodexThreads(pr).length, 3);
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
  const closed = codexClosedBody(pr, 1);
  assert.ok(closed.startsWith(MARKERS.codexClosed));
  assert.match(closed, /@author35, closing this pull request: 1 Codex review thread is/);
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
    codexCloseDue({
      reminderAt: ago(8 * DAY),
      newestThreadAt: ago(10 * DAY),
      lastActivity: null,
      now: NOW,
      ...extras,
    });
  assert.equal(due({}), true);
  assert.equal(due({ reminderAt: ago(CODEX_CLOSE_MS) }), false);
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
  assert.ok(client.writes[1].params.body.startsWith(MARKERS.codexClosed));
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
        botComment(802, codexClosedBody(pr, 1), ago(DAY)),
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
