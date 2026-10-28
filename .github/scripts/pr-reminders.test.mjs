import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKERS,
  MAX_WRITES_PER_RUN,
  approvalBody,
  approvalSince,
  conflictBody,
  conflictSince,
  decide,
  fetchClient,
  findReminder,
  globalOwners,
  groupRunsBySha,
  isDryRun,
  isStale,
  listOpenPullRequests,
  run,
  summaryMarkdown,
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
const botComment = (id, body) => ({
  id,
  body,
  user: { login: 'github-actions[bot]', type: 'Bot' },
});

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

function fakeClient({ prs, pending = [], branchRuns = {}, comments = {}, codeowners = null }) {
  const writes = [];
  return {
    writes,
    async graphql() {
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
