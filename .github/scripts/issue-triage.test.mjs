import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MARKER,
  buildPlan,
  collectContext,
  fingerprint,
  isOurComment,
  parseIssueNumber,
  publishResult,
  readThread,
  safeText,
  searchTerms,
  shouldPublish,
  validateResult,
} from './issue-triage.mjs';

const repo = { owner: 'THU-MAIC', repo: 'OpenMAIC' };
const files = new Set(['lib/hooks/use-discussion-tts.ts']);
const available = [
  'bug',
  'enhancement',
  'documentation',
  'type:question',
  'area:playback',
  'area:editor',
  'area:storage',
  'status:needs-info',
];
const makeIssue = (number = 1434, extras = {}) => ({
  number,
  title: 'Discussion TTS waits until playback ends',
  body: 'Next segment waits.',
  state: 'open',
  locked: false,
  labels: [],
  comments: 0,
  updated_at: '2026-09-09T00:00:00Z',
  user: { login: 'reporter', type: 'User' },
  url: `https://api.github.com/repos/THU-MAIC/OpenMAIC/issues/${number}`,
  ...extras,
});
const makeComment = (extras = {}) => ({
  id: 10,
  updated_at: '2026-09-09T00:00:00Z',
  body: 'Please share the model ID.',
  user: { login: 'maintainer', type: 'User' },
  author_association: 'MEMBER',
  ...extras,
});
const makeThread = (extras = {}) => ({
  issue: makeIssue(),
  comments: [],
  timeline: [],
  truncated: { comments: false, timeline: false },
  ...extras,
});
const makeContext = (thread = makeThread(), extras = {}) => ({
  repository: 'THU-MAIC/OpenMAIC',
  sha: '29735f10d0081859ac3db1a50a0cc92f46436004',
  fingerprint: fingerprint(thread),
  issue: { ...thread.issue, labels: thread.issue.labels.map((l) => l.name) },
  related_issues: [{ number: 1362, state: 'open' }],
  related_prs: [{ number: 1435, state: 'open' }],
  available_labels: available,
  maintainer_engaged: false,
  truncated: { ...thread.truncated, body: false, comment_bodies: false },
  ...extras,
});
const makeResult = (extras = {}) => ({
  type: 'bug',
  areas: ['area:playback'],
  confidence: 0.95,
  summary: 'The next segment waits for playback.',
  next_action: 'investigate',
  questions: [],
  related_issues: [],
  related_prs: [],
  evidence: [{ path: 'lib/hooks/use-discussion-tts.ts', reason: 'Queue scheduling lives here.' }],
  should_comment: true,
  ...extras,
});

function mockGithub(thread = makeThread(), options = {}) {
  const writes = [];
  const reads = [];
  const github = {
    rest: {
      issues: {
        get: async (params) => {
          reads.push(['get', params]);
          if (params.issue_number === thread.issue.number) return { data: thread.issue };
          if (options.references?.[params.issue_number])
            return { data: options.references[params.issue_number] };
          throw Object.assign(new Error('Not found'), { status: 404 });
        },
        listComments: async (params) => ({
          data: options.commentPages?.[params.page] ?? thread.comments,
        }),
        listEventsForTimeline: async (params) => ({
          data: options.timelinePages?.[params.page] ?? thread.timeline,
        }),
        listLabelsForRepo: async () => ({ data: available.map((name) => ({ name })) }),
        listForRepo: async () => ({ data: options.recent ?? [] }),
        createComment: async (params) => {
          if (options.failComment) throw new Error('Comment API failure');
          writes.push(['create', params]);
          thread.comments.push(
            makeComment({
              id: 90,
              body: params.body,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            }),
          );
          thread.issue.comments += 1;
        },
        updateComment: async (params) => {
          writes.push(['update', params]);
          thread.comments.find((c) => c.id === params.comment_id).body = params.body;
        },
        addLabels: async (params) => {
          writes.push(['labels', params]);
          thread.issue.labels.push(...params.labels.map((name) => ({ name })));
        },
      },
      search: {
        issuesAndPullRequests: async (params) => {
          reads.push(['search', params]);
          return { data: { items: options.search ?? [] } };
        },
      },
    },
  };
  return { github, writes, reads };
}

test('issue input is a positive safe integer and cannot become executable text', () => {
  assert.equal(parseIssueNumber('1434'), 1434);
  for (const input of [
    '0',
    '-1',
    '1.5',
    '1e3',
    ' 1',
    '1\n',
    'https://github.com/x/y/issues/1',
    '1; curl x',
    '9007199254740992',
  ]) {
    assert.throws(() => parseIssueNumber(input));
  }
});

test('manual dry runs stay read-only even when automatic apply is enabled', () => {
  assert.equal(shouldPublish('workflow_dispatch', 'apply', false), false);
  assert.equal(shouldPublish('workflow_dispatch', 'off', true), true);
  assert.equal(shouldPublish('issues', 'dry-run', true), false);
  assert.equal(shouldPublish('issues', 'apply', false), true);
});

test('context includes maintainer replies, timeline PRs and explicit references', async () => {
  const pr = makeIssue(1435, { title: 'Fix TTS queue', pull_request: {} });
  const thread = makeThread({
    issue: makeIssue(1434, { body: 'Related to #1362 and #9999', comments: 1 }),
    comments: [makeComment()],
    timeline: [{ event: 'cross-referenced', source: { issue: pr } }],
  });
  const { github, reads, writes } = mockGithub(thread, {
    references: { 1362: makeIssue(1362) },
    recent: [makeIssue(1434), makeIssue(2000)],
    search: [makeIssue(999, { url: 'https://api.github.com/repos/other/repo/issues/999' })],
  });
  const data = await collectContext({ github, repo, issueNumber: 1434, sha: 'abc' });
  assert.equal(data.maintainer_engaged, true);
  assert.equal(data.comments[0].body, 'Please share the model ID.');
  assert.deepEqual(
    data.related_prs.map((i) => i.number),
    [1435],
  );
  assert.deepEqual(
    data.related_issues.map((i) => i.number),
    [1362, 2000],
  );
  assert.equal(data.cross_references[0].number, 1435);
  assert.equal(data.fingerprint, fingerprint(thread));
  assert.equal(reads.filter(([name]) => name === 'search').length, 2);
  assert.deepEqual(writes, []);
});

test('candidate retrieval retains explicit PRs ahead of a full recency window', async () => {
  const { github } = mockGithub(makeThread({ issue: makeIssue(1434, { body: 'See #1435.' }) }), {
    references: { 1435: makeIssue(1435, { pull_request: {} }) },
    recent: Array.from({ length: 100 }, (_, index) =>
      makeIssue(index + 2000, { pull_request: {} }),
    ),
  });
  const data = await collectContext({ github, repo, issueNumber: 1434, sha: 'abc' });
  assert.equal(data.related_prs.length, 30);
  assert.equal(data.related_prs[0].number, 1435);
});

test('closed/locked issues skip analysis and PR numbers are rejected', async () => {
  for (const extras of [{ state: 'closed' }, { locked: true }]) {
    const { github } = mockGithub(makeThread({ issue: makeIssue(1434, extras) }));
    assert.equal(await collectContext({ github, repo, issueNumber: 1434, sha: 'abc' }), null);
  }
  const { github } = mockGithub(makeThread({ issue: makeIssue(1434, { pull_request: {} }) }));
  await assert.rejects(
    collectContext({ github, repo, issueNumber: 1434, sha: 'abc' }),
    /Pull requests/,
  );
});

test('long discussions retain recent replies and expose truncation to publication', async () => {
  const { github } = mockGithub(makeThread({ issue: makeIssue(1434, { comments: 305 }) }), {
    commentPages: {
      3: Array.from({ length: 100 }, (_, index) => makeComment({ id: index + 201 })),
      4: [makeComment({ id: 305, body: 'Newest reply' })],
    },
  });
  const thread = await readThread(github, repo, 1434);
  assert.equal(thread.truncated.comments, true);
  const data = await collectContext({ github, repo, issueNumber: 1434, sha: 'abc' });
  assert.equal(data.comments.length, 50);
  assert.equal(data.comments.at(-1).body, 'Newest reply');
  assert.equal(buildPlan(makeResult(), data).comment, null);
});

test('title search terms cannot inject GitHub query qualifiers', () => {
  for (const term of searchTerms('[Bug]: repo:private/secret OR is:pr "hello"')) {
    assert.match(term, /^[\p{L}\p{N}_-]+$/u);
  }
});

test('valid structured result passes, including a supplied PR and tracked code evidence', () => {
  const result = makeResult({
    next_action: 'review-pr',
    related_prs: [{ number: 1435, reason: 'Implements lookahead.' }],
  });
  assert.deepEqual(validateResult(JSON.stringify(result), makeContext(), files), result);
});

test('malformed, oversized, extra-field and invalid enum outputs fail closed', () => {
  const invalid = [
    'not JSON',
    '{}',
    'x'.repeat(16001),
    JSON.stringify(null),
    JSON.stringify(makeResult({ command: 'gh issue close 1434' })),
    JSON.stringify(makeResult({ areas: ['priority:P0'] })),
    JSON.stringify(makeResult({ confidence: 1.1 })),
    JSON.stringify(makeResult({ should_comment: 'true' })),
    JSON.stringify(makeResult({ summary: '' })),
    JSON.stringify(makeResult({ questions: Array(4).fill('Question?') })),
    JSON.stringify(
      makeResult({ related_prs: [{ number: 1435, reason: 'Fix', url: 'https://evil.test' }] }),
    ),
  ];
  for (const raw of invalid) assert.throws(() => validateResult(raw, makeContext(), files));
});

test('unknown issue/PR numbers, cross-kind references and invented paths fail closed', () => {
  for (const change of [
    { related_issues: [{ number: 999, reason: 'Duplicate' }] },
    { related_issues: [{ number: 1435, reason: 'Wrong kind' }] },
    { related_prs: [{ number: 1362, reason: 'Wrong kind' }] },
    { related_prs: [{ number: 1435.1, reason: 'Not an integer' }] },
    { evidence: [{ path: '../../.env', reason: 'Read this' }] },
    { next_action: 'review-pr' },
    { next_action: 'needs-info' },
    { questions: ['Question without needs-info'] },
  ])
    assert.throws(() => validateResult(JSON.stringify(makeResult(change)), makeContext(), files));
});

test('existing human labels win in each group and priorities are never added', () => {
  const context = makeContext(
    makeThread({
      issue: makeIssue(1434, {
        labels: ['enhancement', 'area:editor', 'priority:P1', 'status:ready'].map((name) => ({
          name,
        })),
      }),
    }),
  );
  const plan = buildPlan(
    makeResult({ next_action: 'needs-info', questions: ['Which model?'] }),
    context,
  );
  assert.deepEqual(plan.labels, []);
  assert.equal(plan.comment, null);
});

test('only existing allowlisted labels are added and question uses type:question', () => {
  assert.deepEqual(buildPlan(makeResult({ type: 'question' }), makeContext()).labels, [
    'type:question',
    'area:playback',
  ]);
  assert.deepEqual(
    buildPlan(makeResult(), makeContext(undefined, { available_labels: [] })).labels,
    [],
  );
  for (const type of ['type:rfc', 'type:epic', 'type:task', 'question']) {
    const context = makeContext(
      makeThread({ issue: makeIssue(1434, { labels: [{ name: type }] }) }),
    );
    assert.deepEqual(buildPlan(makeResult(), context).labels, ['area:playback']);
  }
});

test('low confidence retains the assessment without public mutations', () => {
  assert.deepEqual(buildPlan(makeResult({ confidence: 0.84 }), makeContext()), {
    labels: [],
    comment: null,
  });
});

test('closed PRs can be related context but cannot be proposed for review', () => {
  const context = makeContext(undefined, { related_prs: [{ number: 1435, state: 'closed' }] });
  const result = makeResult({ related_prs: [{ number: 1435, reason: 'Historical attempt.' }] });
  assert.deepEqual(validateResult(JSON.stringify(result), context, files), result);
  assert.throws(
    () => validateResult(JSON.stringify({ ...result, next_action: 'review-pr' }), context, files),
    /open PR/,
  );
});

test('an existing disposition suppresses unsolicited follow-up comments', () => {
  for (const name of [
    'status:needs-info',
    'status:in-progress',
    'duplicate',
    'invalid',
    'wontfix',
  ]) {
    const context = makeContext(makeThread({ issue: makeIssue(1434, { labels: [{ name }] }) }));
    assert.equal(buildPlan(makeResult(), context).comment, null);
  }
});

test('needs-info requires an eligible new question; existing work and discussion suppress it', () => {
  const result = makeResult({ next_action: 'needs-info', questions: ['Which model ID?'] });
  assert.ok(buildPlan(result, makeContext()).labels.includes('status:needs-info'));
  for (const change of [
    { maintainer_engaged: true },
    { truncated: { comments: true } },
    { truncated: { timeline: true } },
    { truncated: { body: true } },
    { truncated: { comment_bodies: true } },
  ]) {
    const plan = buildPlan(result, makeContext(undefined, change));
    assert.equal(plan.comment, null);
    assert.ok(!plan.labels.includes('status:needs-info'));
  }
  const existingWork = buildPlan(
    { ...result, related_prs: [{ number: 1435, reason: 'Fix' }] },
    makeContext(),
  );
  assert.equal(existingWork.comment, null);
  assert.ok(!existingWork.labels.includes('status:needs-info'));
  assert.equal(buildPlan({ ...result, should_comment: false }, makeContext()).comment, null);
});

test('model text cannot inject HTML, images, external links or notification mentions', () => {
  const text = '<script>x</script> ![click](https://evil.test/?secret=abc) @owner **urgent**';
  const rendered = safeText(text);
  assert.ok(!rendered.includes('<script>'));
  assert.ok(!rendered.includes('https://evil'));
  assert.ok(!rendered.includes('@owner'));
  assert.ok(rendered.includes('\\!\\['));
  const comment = buildPlan(makeResult({ summary: text }), makeContext()).comment;
  assert.ok(
    comment.includes(
      '/blob/29735f10d0081859ac3db1a50a0cc92f46436004/lib/hooks/use-discussion-tts.ts',
    ),
  );
});

test('only the real Actions bot owns a triage comment', () => {
  assert.equal(isOurComment(makeComment({ body: MARKER })), false);
  assert.equal(
    isOurComment(
      makeComment({ body: MARKER, user: { login: 'github-actions[bot]', type: 'User' } }),
    ),
    false,
  );
  assert.equal(
    isOurComment(
      makeComment({ body: MARKER, user: { login: 'github-actions[bot]', type: 'Bot' } }),
    ),
    true,
  );
});

test('first publish and repeated runs create one comment and add labels once', async () => {
  const thread = makeThread();
  const { github, writes } = mockGithub(thread);
  const raw = JSON.stringify(makeResult());
  await publishResult({ github, repo, context: makeContext(thread), raw, files });
  assert.deepEqual(
    writes.map(([name]) => name),
    ['create', 'labels'],
  );
  await publishResult({ github, repo, context: makeContext(thread), raw, files });
  assert.deepEqual(
    writes.map(([name]) => name),
    ['create', 'labels'],
  );
  await publishResult({
    github,
    repo,
    context: makeContext(thread),
    raw: JSON.stringify(makeResult({ summary: 'Updated analysis.' })),
    files,
  });
  assert.deepEqual(
    writes.map(([name]) => name),
    ['create', 'labels', 'update'],
  );
});

test('a reporter spoofing the bot marker is never overwritten', async () => {
  const thread = makeThread({
    comments: [makeComment({ body: MARKER, author_association: 'NONE' })],
  });
  const { github, writes } = mockGithub(thread);
  await publishResult({
    github,
    repo,
    context: makeContext(thread),
    raw: JSON.stringify(makeResult()),
    files,
  });
  assert.deepEqual(
    writes.map(([name]) => name),
    ['create', 'labels'],
  );
  assert.equal(thread.comments[0].body, MARKER);
});

test('closed, locked, edited, newly labeled or newly discussed issues skip all writes', async () => {
  const changes = [
    (t) => {
      t.issue.state = 'closed';
    },
    (t) => {
      t.issue.locked = true;
    },
    (t) => {
      t.issue.body += '\nNew reproduction';
    },
    (t) => {
      t.issue.labels.push({ name: 'status:in-progress' });
    },
    (t) => {
      t.comments.push(makeComment());
    },
    (t) => {
      t.timeline.push({
        event: 'cross-referenced',
        source: { issue: makeIssue(1435, { pull_request: {} }) },
      });
    },
  ];
  for (const change of changes) {
    const thread = makeThread();
    const context = structuredClone(makeContext(thread));
    change(thread);
    const { github, writes } = mockGithub(thread);
    const result = await publishResult({
      github,
      repo,
      context,
      raw: JSON.stringify(makeResult()),
      files,
    });
    assert.ok(result.skipped);
    assert.deepEqual(writes, []);
  }
});

test('invalid output and repository mismatch fail before any GitHub mutation', async () => {
  const { github, writes, reads } = mockGithub();
  await assert.rejects(publishResult({ github, repo, context: makeContext(), raw: '{}', files }));
  await assert.rejects(
    publishResult({
      github,
      repo,
      context: makeContext(undefined, { repository: 'other/repo' }),
      raw: JSON.stringify(makeResult()),
      files,
    }),
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(reads, []);
});

test('failed question publication does not leave a needs-info label behind', async () => {
  const { github, writes } = mockGithub(makeThread(), { failComment: true });
  await assert.rejects(
    publishResult({
      github,
      repo,
      context: makeContext(),
      raw: JSON.stringify(makeResult({ next_action: 'needs-info', questions: ['Which model?'] })),
      files,
    }),
    /Comment API/,
  );
  assert.deepEqual(writes, []);
});

test('schema changes cannot silently add validation keywords the local validator ignores', () => {
  const schema = JSON.parse(readFileSync(new URL('../triage/output.schema.json', import.meta.url)));
  const supported = new Set([
    'type',
    'additionalProperties',
    'required',
    'properties',
    'enum',
    'items',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
  ]);
  function visit(rule) {
    for (const key of Object.keys(rule))
      assert.ok(supported.has(key), `Unsupported schema keyword: ${key}`);
    if (rule.type === 'object') {
      assert.equal(rule.additionalProperties, false);
      assert.deepEqual([...rule.required].sort(), Object.keys(rule.properties).sort());
      Object.values(rule.properties).forEach(visit);
    }
    if (rule.items) visit(rule.items);
  }
  visit(schema);
});
