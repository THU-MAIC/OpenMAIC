// Weekly maintainer sweep digest (see MAINTAINING.md). One issue, created by
// the Actions bot and identified by a hidden marker, is updated in place with:
//
// - untriaged issues, oldest first;
// - issues labelled `status:blocked`;
// - `status:needs-info` issues whose author has replied (the daily reminders
//   remove that label; this lists the ones still labelled);
// - pull requests ready for review: not a draft, no conflicts, CI green, no
//   unresolved Codex review threads and no maintainer review since the latest
//   push;
// - provider pull requests (`area:providers`) from contributors that no
//   maintainer has reviewed yet, so they still await an accept/decline call.
//
// The module is used by .github/workflows/maintainer-digest.yml through
// actions/github-script. It can also be run locally, always as a dry run:
//   GITHUB_TOKEN=$(gh auth token) node .github/scripts/maintainer-digest.mjs
import { pathToFileURL } from 'node:url';
import {
  LABELS,
  assigneeLogins,
  hasLabel,
  isEligible,
  lastActivity,
  linkedOpenPullRequests,
  listOpenIssues,
  needsInfoState,
} from './issue-reminders.mjs';
import { fetchClient, isDryRun, unresolvedCodexThreads } from './pr-reminders.mjs';

export { fetchClient, isDryRun };

export const MARKER = '<!-- openmaic-maintainer-digest:v1 -->';
export const TITLE = 'Maintainer sweep';
export const PROVIDERS_LABEL = 'area:providers';
export const DECISION_DAYS = 7;
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const BOT_LOGIN = 'github-actions[bot]';
const MAX_BODY = 60000;
const DAY = 24 * 60 * 60 * 1000;

function time(value) {
  return value ? Date.parse(value) : 0;
}

// ---- Classification (pure) ----

// Untriaged: nobody owns it, it waits on nobody, and no pull request is open
// for it (that would make it in progress).
export function isUntriaged(issue, repoName) {
  return (
    isEligible(issue) &&
    !assigneeLogins(issue).length &&
    ![LABELS.needsInfo, LABELS.blocked, LABELS.helpWanted].some((name) => hasLabel(issue, name)) &&
    !linkedOpenPullRequests(issue, repoName).length
  );
}

export function isBlocked(issue) {
  return isEligible(issue) && hasLabel(issue, LABELS.blocked);
}

export function needsInfoReplied(issue) {
  return isEligible(issue) && Boolean(needsInfoState(issue)?.repliedAt);
}

function headCommit(pr) {
  return pr.commits?.nodes?.[0]?.commit ?? null;
}

// Check suites are created when the commit is pushed, unlike the commit date
// (which a rebase or an old local commit can predate).
export function headPushedAt(pr) {
  const commit = headCommit(pr);
  const suites = (commit?.checkSuites?.nodes ?? []).map((suite) => time(suite.createdAt));
  const at = suites.length ? Math.min(...suites) : time(commit?.committedDate);
  return at ? new Date(at).toISOString() : null;
}

export function isMaintainerReview(review, pr) {
  return (
    MAINTAINERS.has(review.authorAssociation) &&
    review.author?.__typename !== 'Bot' &&
    review.author?.login !== pr.author?.login
  );
}

export function isReadyForReview(pr) {
  if (pr.isDraft || pr.mergeable !== 'MERGEABLE') return false;
  if (headCommit(pr)?.statusCheckRollup?.state !== 'SUCCESS') return false;
  // Threads beyond the first page are unknown: do not claim the PR is clean.
  if (pr.reviewThreads?.pageInfo?.hasNextPage || unresolvedCodexThreads(pr).length) return false;
  const pushedAt = time(headPushedAt(pr));
  return !(pr.reviews?.nodes ?? []).some(
    (review) => isMaintainerReview(review, pr) && time(review.submittedAt) > pushedAt,
  );
}

export function awaitsProviderDecision(pr) {
  return (
    !pr.isDraft &&
    (pr.labels?.nodes ?? []).some((label) => label.name === PROVIDERS_LABEL) &&
    !MAINTAINERS.has(pr.authorAssociation) &&
    !(pr.reviews?.nodes ?? []).some((review) => isMaintainerReview(review, pr))
  );
}

export function classify({ issues, prs, repoName }) {
  const byTime = (pick) => (a, b) => time(pick(a)) - time(pick(b));
  return {
    untriaged: issues
      .filter((issue) => isUntriaged(issue, repoName))
      .sort(byTime((issue) => issue.createdAt)),
    blocked: issues.filter(isBlocked).sort(byTime((issue) => issue.createdAt)),
    replied: issues.filter(needsInfoReplied).sort(byTime((i) => needsInfoState(i).repliedAt)),
    ready: prs.filter(isReadyForReview).sort(byTime(headPushedAt)),
    providers: prs.filter(awaitsProviderDecision).sort(byTime((pr) => pr.createdAt)),
  };
}

// ---- Rendering ----

// Titles are untrusted: no mentions, issue references or markup.
export function safeTitle(title) {
  return String(title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}[\]()<>|!~]/g, '\\$&')
    .replace(/@/g, '@​')
    .replace(/#(?=\d)/g, '#​');
}

export function age(since, now) {
  const days = Math.floor((now - time(since)) / DAY);
  return days < 1 ? 'under a day' : `${days} day${days === 1 ? '' : 's'}`;
}

function searchLink(repoName, query) {
  return `https://github.com/${repoName}/issues?q=${encodeURIComponent(query)}`;
}

function section(title, query, repoName, items, line, empty, { total = items.length, note } = {}) {
  const lines = [
    `## ${title} (${total})`,
    '',
    `[Open in search](${searchLink(repoName, query)})`,
    '',
  ];
  if (!items.length) lines.push(note ?? empty);
  else {
    for (const item of items) lines.push(line(item));
    if (note) lines.push('', note);
  }
  lines.push('');
  return lines;
}

// Only recent untriaged issues are linked: every link adds a "mentioned in"
// event to the issue, and the older backlog is one search away.
export const UNTRIAGED_LIST_DAYS = 30;

export function recentUntriaged(untriaged, now) {
  const since = now - UNTRIAGED_LIST_DAYS * 24 * 60 * 60 * 1000;
  return untriaged.filter((issue) => time(issue.createdAt) >= since);
}

function untriagedOptions(untriaged, now) {
  const older = untriaged.length - recentUntriaged(untriaged, now).length;
  if (!untriaged.length) return {};
  return {
    total: untriaged.length,
    note: older
      ? `${older} older untriaged ${older === 1 ? 'issue is' : 'issues are'} not listed here; see the search link.`
      : undefined,
  };
}

export function renderDigest({ repoName, now, scanned, sections }) {
  const link = (item) => `[#${item.number}](${item.url}) ${safeTitle(item.title)}`;
  const lines = [
    MARKER,
    `# ${TITLE}`,
    '',
    `Updated ${new Date(now).toISOString().slice(0, 10)} (weekly). Scanned ${scanned.issues} open issues and ${scanned.prs} open pull requests. The sweep checklist and the lifecycle are in [MAINTAINING.md](https://github.com/${repoName}/blob/main/MAINTAINING.md).`,
    '',
    ...section(
      'Untriaged issues',
      'is:issue is:open no:assignee -linked:pr -label:"status:needs-info" -label:"status:blocked" -label:"help wanted" sort:created-asc',
      repoName,
      recentUntriaged(sections.untriaged, now),
      (issue) => `- ${link(issue)}: opened ${age(issue.createdAt, now)} ago`,
      'None. Every open issue has an owner or a status.',
      untriagedOptions(sections.untriaged, now),
    ),
    ...section(
      'Blocked on maintainers',
      'is:issue is:open label:"status:blocked" sort:created-asc',
      repoName,
      sections.blocked,
      (issue) =>
        `- ${link(issue)}: opened ${age(issue.createdAt, now)} ago, last activity ${age(lastActivity(issue, repoName), now)} ago`,
      'None.',
    ),
    ...section(
      'Needs info, author replied',
      'is:issue is:open label:"status:needs-info"',
      repoName,
      sections.replied,
      (issue) =>
        `- ${link(issue)}: author replied ${age(needsInfoState(issue).repliedAt, now)} ago`,
      'None.',
    ),
    ...section(
      'Pull requests ready for review',
      'is:pr is:open draft:false status:success sort:updated-asc',
      repoName,
      sections.ready,
      (pr) => `- ${link(pr)}: waiting ${age(headPushedAt(pr), now)} since the latest push`,
      'None.',
    ),
    ...section(
      'Provider pull requests awaiting a decision',
      `is:pr is:open draft:false label:${PROVIDERS_LABEL} sort:created-asc`,
      repoName,
      sections.providers,
      (pr) => {
        const overdue =
          now - time(pr.createdAt) > DECISION_DAYS * DAY ? ' (past the 7-day decision window)' : '';
        return `- ${link(pr)}: opened ${age(pr.createdAt, now)} ago${overdue}`;
      },
      'None.',
    ),
    '<sub>Generated by the weekly maintainer digest workflow and updated in place.</sub>',
    '',
  ];
  let body = lines.join('\n');
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n\n_Digest truncated to fit the issue size limit; see the workflow job summary._\n`;
  }
  return body;
}

// ---- GitHub access (an octokit-compatible `request` / `graphql` client) ----

const PR_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft mergeable createdAt authorAssociation
        author { login __typename }
        labels(first: 50) { nodes { name } }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            isResolved
            comments(first: 1) { nodes { author { login __typename } createdAt } }
          }
        }
        reviews(last: 50) { nodes { authorAssociation submittedAt author { login __typename } } }
        commits(last: 1) {
          nodes {
            commit {
              committedDate
              statusCheckRollup { state }
              checkSuites(first: 20) { nodes { createdAt } }
            }
          }
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

// `mergeable` is computed lazily and may first come back UNKNOWN; such pull
// requests are re-queried a few times and otherwise left out of "ready".
export async function listOpenPullRequests(
  client,
  repo,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 3 } = {},
) {
  let prs = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    prs = await queryOpenPullRequests(client, repo, 5);
    if (!prs.some((pr) => !pr.isDraft && pr.mergeable === 'UNKNOWN')) break;
    if (attempt < attempts) await sleep(5000 * attempt);
  }
  return prs;
}

export async function upsertIssue(client, repo, body) {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await client.request('GET /repos/{owner}/{repo}/issues', {
      ...repo,
      state: 'open',
      creator: BOT_LOGIN,
      per_page: 100,
      page,
    });
    items.push(...data);
    if (data.length < 100) break;
  }
  const existing = items.find((issue) => !issue.pull_request && issue.body?.startsWith(MARKER));
  if (existing) {
    await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repo,
      issue_number: existing.number,
      title: TITLE,
      body,
    });
    return { action: 'updated', number: existing.number, url: existing.html_url };
  }
  const { data } = await client.request('POST /repos/{owner}/{repo}/issues', {
    ...repo,
    title: TITLE,
    body,
  });
  return { action: 'created', number: data.number, url: data.html_url };
}

export async function run({ client, repo, now = Date.now(), dryRun = true, log = console.log }) {
  const repoName = `${repo.owner}/${repo.repo}`;
  const [issues, prs] = await Promise.all([
    listOpenIssues(client, repo),
    listOpenPullRequests(client, repo),
  ]);
  const sections = classify({ issues, prs, repoName });
  log(
    Object.entries(sections)
      .map(([name, items]) => `${name}: ${items.length}`)
      .join(', '),
  );
  const body = renderDigest({
    repoName,
    now,
    scanned: { issues: issues.length, prs: prs.length },
    sections,
  });
  const issue = dryRun ? null : await upsertIssue(client, repo, body);
  return { dryRun, sections, body, issue };
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
  console.log('\n' + result.body);
}
