import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const MARKER = '<!-- openmaic-issue-triage:v1 -->';
export const CONFIDENCE_THRESHOLD = 0.85;
const schema = JSON.parse(readFileSync(new URL('../triage/output.schema.json', import.meta.url)));
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TYPE_LABELS = new Set([
  'bug',
  'enhancement',
  'documentation',
  'question',
  'type:question',
  'type:task',
  'type:epic',
  'type:rfc',
]);

export function parseIssueNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Provide a positive issue number, not a URL or shell expression.');
  }
  return Number(value);
}

export function shouldPublish(eventName, mode, publish) {
  return eventName === 'workflow_dispatch' ? publish === true : mode === 'apply';
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

export function isOurComment(comment) {
  return (
    comment.user?.login === 'github-actions[bot]' &&
    comment.user?.type === 'Bot' &&
    comment.body?.startsWith(MARKER)
  );
}

// Bound every list, including historical issues with very long discussions.
async function pages(method, params, maxPages = 3) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await method({ ...params, per_page: 100, page });
    items.push(...data);
    if (data.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export async function readThread(github, repo, issueNumber) {
  const params = { ...repo, issue_number: parseIssueNumber(issueNumber) };
  const { data: issue } = await github.rest.issues.get(params);
  if (issue.pull_request) throw new Error('Pull requests are not issue-triage targets.');
  const lastPage = Math.max(1, Math.ceil(issue.comments / 100));
  const commentPages = await Promise.all(
    [...new Set([Math.max(1, lastPage - 1), lastPage])].map((page) =>
      github.rest.issues.listComments({ ...params, per_page: 100, page }),
    ),
  );
  const comments = commentPages.flatMap(({ data }) => data);
  const timeline = await pages(github.rest.issues.listEventsForTimeline, params);
  return {
    issue,
    comments,
    timeline: timeline.items,
    truncated: { comments: lastPage > 2, timeline: timeline.truncated },
  };
}

export function fingerprint(thread) {
  const { issue, comments, timeline } = thread;
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: issue.title,
        body: issue.body,
        state: issue.state,
        locked: issue.locked,
        updated_at: issue.updated_at,
        labels: issue.labels.map((label) => label.name).sort(),
        comments: comments.map((c) => [c.id, c.updated_at, c.body]),
        timeline: timeline.map((e) => [
          e.id,
          e.event,
          e.created_at,
          e.source?.issue?.number,
          e.source?.issue?.state,
          e.source?.issue?.updated_at,
        ]),
      }),
    )
    .digest('hex');
}

function compactIssue(issue) {
  return {
    number: issue.number,
    title: clip(issue.title, 300),
    body: clip(issue.body, 1500),
    state: issue.state,
    kind: issue.pull_request ? 'pr' : 'issue',
    labels: issue.labels?.map((label) => label.name) ?? [],
  };
}

export function searchTerms(title) {
  const stop = new Set([
    'bug',
    'feature',
    'request',
    'issue',
    'with',
    'from',
    'this',
    'that',
    'when',
    'does',
    'cannot',
    'openmaic',
    'support',
    'should',
    'task',
  ]);
  return [
    ...new Set(
      (title.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])
        .filter((word) => !stop.has(word))
        .map((word) => word.slice(0, 40)),
    ),
  ].slice(0, 2);
}

export async function collectContext({ github, repo, issueNumber, sha }) {
  const thread = await readThread(github, repo, issueNumber);
  if (thread.issue.state !== 'open' || thread.issue.locked) return null;
  const repository = `${repo.owner}/${repo.repo}`;
  const apiPrefix = `https://api.github.com/repos/${repository}/issues/`.toLowerCase();
  const sameRepo = (item) => item?.url?.toLowerCase().startsWith(apiPrefix);
  const linked = thread.timeline
    .filter((e) => e.event === 'cross-referenced')
    .map((e) => e.source?.issue)
    .filter(sameRepo);
  const referenceText = [thread.issue.body, ...thread.comments.map((c) => c.body)].join('\n');
  const references = [
    ...new Set(
      [...referenceText.matchAll(/(?:^|[\s(])#([1-9]\d*)\b/g)].map((match) => Number(match[1])),
    ),
  ]
    .filter((n) => Number.isSafeInteger(n) && n !== issueNumber)
    .slice(0, 10);
  const [labels, recent, searches, referenced] = await Promise.all([
    pages(github.rest.issues.listLabelsForRepo, repo),
    github.rest.issues.listForRepo({
      ...repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    }),
    Promise.all(
      searchTerms(thread.issue.title).map((term) =>
        github.rest.search.issuesAndPullRequests({
          q: `repo:${repository} in:title ${term}`,
          per_page: 20,
        }),
      ),
    ),
    Promise.all(
      references.map(async (number) => {
        try {
          return (await github.rest.issues.get({ ...repo, issue_number: number })).data;
        } catch (error) {
          if (error.status === 404 || error.status === 410) return null;
          throw error;
        }
      }),
    ),
  ]);
  // Explicit references and timeline links take precedence over search and recency.
  const candidates = [
    ...new Map(
      [...linked, ...referenced, ...searches.flatMap((s) => s.data.items), ...recent.data]
        .filter((item) => sameRepo(item) && item.number !== issueNumber)
        .map((item) => [item.number, item]),
    ).values(),
  ];
  const select = (kind) =>
    candidates
      .filter((i) => Boolean(i.pull_request) === (kind === 'pr'))
      .slice(0, 30)
      .map(compactIssue);
  return {
    repository,
    sha,
    fingerprint: fingerprint(thread),
    issue: {
      ...compactIssue(thread.issue),
      body: clip(thread.issue.body, 16000),
      author: thread.issue.user.login,
      updated_at: thread.issue.updated_at,
    },
    comments: thread.comments.slice(-50).map((c) => ({
      id: c.id,
      author: c.user?.login,
      association: c.author_association,
      bot: c.user?.type === 'Bot',
      ours: isOurComment(c),
      body: clip(c.body, 1000),
    })),
    maintainer_engaged: thread.comments.some(
      (c) => c.user?.type !== 'Bot' && MAINTAINERS.has(c.author_association),
    ),
    truncated: {
      ...thread.truncated,
      comments: thread.truncated.comments || thread.comments.length > 50,
      body: (thread.issue.body?.length ?? 0) > 16000,
      comment_bodies: thread.comments.some((c) => (c.body?.length ?? 0) > 1000),
      candidates: true,
      labels: labels.truncated,
    },
    available_labels: labels.items.map((label) => label.name),
    cross_references: linked.map((i) => ({
      number: i.number,
      kind: i.pull_request ? 'pr' : 'issue',
      state: i.state,
    })),
    related_issues: select('issue'),
    related_prs: select('pr'),
  };
}

// The same bounded schema drives Codex output and validation in the trusted job.
// Only the schema keywords used in output.schema.json are supported here.
export function validateSchema(value, rule = schema, path = 'result') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type !== rule.type && !(rule.type === 'integer' && Number.isSafeInteger(value))) {
    throw new Error(`${path}: expected ${rule.type}`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path}: invalid enum value`);
  if (type === 'object') {
    for (const key of rule.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}: missing ${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(rule.properties, key)) throw new Error(`${path}: unexpected property`);
      validateSchema(item, rule.properties[key], `${path}.${key}`);
    }
  }
  if (type === 'array') {
    if (value.length > rule.maxItems) throw new Error(`${path}: too many items`);
    value.forEach((item, index) => validateSchema(item, rule.items, `${path}[${index}]`));
  }
  if (type === 'string' && (value.length < rule.minLength || value.length > rule.maxLength)) {
    throw new Error(`${path}: invalid string length`);
  }
  if (
    type === 'number' &&
    (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)
  ) {
    throw new Error(`${path}: invalid number`);
  }
  return value;
}

export function validateResult(raw, context, trackedFiles) {
  if (Buffer.byteLength(raw) > 16000) throw new Error('Triage result exceeds 16 KB.');
  const result = validateSchema(JSON.parse(raw));
  for (const kind of ['related_issues', 'related_prs']) {
    const known = new Set(context[kind].map((item) => item.number));
    if (result[kind].some((item) => !known.has(item.number)))
      throw new Error(`Unknown ${kind} reference.`);
  }
  if (result.evidence.some((item) => !trackedFiles.has(item.path)))
    throw new Error('Unknown source path.');
  if (result.next_action === 'needs-info' && result.questions.length === 0) {
    throw new Error('needs-info requires a concrete question.');
  }
  if (result.next_action !== 'needs-info' && result.questions.length !== 0) {
    throw new Error('Questions are only valid for needs-info.');
  }
  if (
    result.next_action === 'review-pr' &&
    !result.related_prs.some((ref) =>
      context.related_prs.some((pr) => pr.number === ref.number && pr.state === 'open'),
    )
  ) {
    throw new Error('review-pr requires a known open PR.');
  }
  return result;
}

export function trackedFiles() {
  return new Set(
    execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean),
  );
}

export function safeText(value) {
  return value
    .replace(/https?:\/\/\S+/gi, '[external URL omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#!|]/g, '\\$&');
}

export function buildPlan(result, context) {
  const existing = context.issue.labels;
  const labels = [];
  const confident = result.confidence >= CONFIDENCE_THRESHOLD;
  const disposition = existing.some(
    (label) => label.startsWith('status:') || ['duplicate', 'invalid', 'wontfix'].includes(label),
  );
  if (confident) {
    if (!existing.some((label) => TYPE_LABELS.has(label))) {
      const type = result.type === 'question' ? 'type:question' : result.type;
      if (type !== 'unknown') labels.push(type);
    }
    if (!existing.some((label) => label.startsWith('area:'))) labels.push(...result.areas);
  }
  const incomplete =
    context.truncated.comments ||
    context.truncated.timeline ||
    context.truncated.body ||
    context.truncated.comment_bodies;
  const openPr = result.related_prs.some((ref) =>
    context.related_prs.some((pr) => pr.number === ref.number && pr.state === 'open'),
  );
  const canAsk = !context.maintainer_engaged && !incomplete && !openPr;
  const comment =
    confident &&
    result.should_comment &&
    result.next_action !== 'none' &&
    !disposition &&
    !context.maintainer_engaged &&
    !incomplete &&
    (result.next_action !== 'needs-info' || canAsk)
      ? renderComment(result, context)
      : null;
  if (
    comment &&
    result.next_action === 'needs-info' &&
    !existing.some((label) => label.startsWith('status:'))
  ) {
    labels.push('status:needs-info');
  }
  return {
    labels: [...new Set(labels)].filter(
      (label) => context.available_labels.includes(label) && !existing.includes(label),
    ),
    comment,
  };
}

function renderComment(result, context) {
  const root = `https://github.com/${context.repository}`;
  const refs = (items, kind) =>
    items.map((r) => `- [#${r.number}](${root}/${kind}/${r.number}): ${safeText(r.reason)}`);
  return [
    MARKER,
    '**OpenMAIC automated triage**',
    '',
    safeText(result.summary),
    '',
    `Suggested next step: **${result.next_action}**.`,
    ...result.questions.map((q) => `- ${safeText(q)}`),
    ...refs(result.related_issues, 'issues'),
    ...refs(result.related_prs, 'pull'),
    ...result.evidence.map(
      (e) =>
        `- [${safeText(e.path)}](${root}/blob/${context.sha}/${e.path.split('/').map(encodeURIComponent).join('/')}): ${safeText(e.reason)}`,
    ),
    '',
    '_AI-generated assessment from the issue, discussion and source. No reproduction was executed; maintainers decide the next action._',
  ].join('\n');
}

export async function publishResult({ github, repo, context, raw, files }) {
  if (context.repository !== `${repo.owner}/${repo.repo}`) throw new Error('Repository mismatch.');
  const result = validateResult(raw, context, files);
  const current = await readThread(github, repo, context.issue.number);
  if (
    current.issue.state !== 'open' ||
    current.issue.locked ||
    fingerprint(current) !== context.fingerprint
  ) {
    return { skipped: 'Issue or discussion changed during analysis; rerun triage.' };
  }
  const plan = buildPlan(result, context);
  const params = { ...repo, issue_number: context.issue.number };
  // Comment first: a failed post must not leave a needs-info label with no question.
  if (plan.comment) {
    const own = current.comments.find(isOurComment);
    if (own && own.body !== plan.comment) {
      await github.rest.issues.updateComment({ ...repo, comment_id: own.id, body: plan.comment });
    } else if (!own) {
      await github.rest.issues.createComment({ ...params, body: plan.comment });
    }
  }
  if (plan.labels.length) await github.rest.issues.addLabels({ ...params, labels: plan.labels });
  return { labels: plan.labels, comment: Boolean(plan.comment) };
}
