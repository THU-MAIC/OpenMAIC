/**
 * PBL v2 — Gitea REST client.
 *
 * Thin typed wrapper over the self-hosted Gitea REST API (v1.22.3). All
 * functions take a resolved {@link GiteaConfig} and return parsed JSON; HTTP
 * and API-level errors throw {@link GiteaClientError} with a status + body
 * message so callers can fail loud with useful context.
 */

import type {
  GiteaAccessToken,
  GiteaBranch,
  GiteaCommit,
  GiteaCommitFile,
  GiteaCommitStatusInput,
  GiteaConfig,
  GiteaFileContent,
  GiteaRepo,
  GiteaUser,
} from './types';

export class GiteaClientError extends Error {
  readonly status: number | undefined;
  readonly apiMessage: string;

  constructor(message: string, status?: number, apiMessage?: string) {
    super(message);
    this.name = 'GiteaClientError';
    this.status = status;
    this.apiMessage = apiMessage ?? '';
  }
}

function authHeaders(config: GiteaConfig): Record<string, string> {
  return {
    Authorization: `token ${config.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Basic-auth headers for the admin account. Gitea's access-token endpoint
 *  (`POST /users/{username}/tokens`) rejects API-token auth, so minting a
 *  learner token must authenticate as the admin with username + password. */
function adminBasicHeaders(config: GiteaConfig): Record<string, string> {
  const user = config.adminUser;
  const password = config.adminPassword;
  if (!user || password === undefined) {
    throw new GiteaClientError(
      'Gitea admin Basic-auth credentials are required to mint learner tokens (set GITEA_ADMIN_USER and GITEA_ADMIN_PASSWORD)',
    );
  }
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Encode a repo path segment for use in a URL (e.g. `owner/repo` with a slash). */
function encodeFullName(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

async function request<T>(config: GiteaConfig, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.baseUrl}/api/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new GiteaClientError(`Failed to reach Gitea at ${url}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    let apiMessage = '';
    try {
      const body = (await res.json()) as { message?: string };
      apiMessage = body?.message ?? '';
    } catch {
      // non-JSON error body — fall through with a status-only message
    }
    throw new GiteaClientError(
      `Gitea ${init.method ?? 'GET'} ${path} failed (${res.status})${apiMessage ? `: ${apiMessage}` : ''}`,
      res.status,
      apiMessage,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Fork the template repo. Forks into the authenticated user's namespace by
 * default, or into `organization` when provided. Returns the forked repo.
 */
export async function createFork(
  config: GiteaConfig,
  options: { organization?: string; name?: string } = {},
): Promise<GiteaRepo> {
  const [owner, repo] = config.templateFullName.split('/');
  const body: Record<string, string> = {};
  if (options.organization) body.organization = options.organization;
  if (options.name) body.name = options.name;

  return request<GiteaRepo>(config, `/repos/${encodeFullName(`${owner}/${repo}`)}/forks`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });
}

/** Create a push webhook on a repo. Returns the created hook's id. */
export async function createWebhook(
  config: GiteaConfig,
  fullName: string,
  webhookUrl: string,
  secret: string,
): Promise<number> {
  const res = await request<{ id?: number }>(config, `/repos/${encodeFullName(fullName)}/hooks`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      type: 'gitea',
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret,
      },
      events: ['push'],
      active: true,
    }),
  });
  if (typeof res.id !== 'number') {
    throw new GiteaClientError('Gitea createWebhook returned no hook id');
  }
  return res.id;
}

/** Create a Gitea user via the admin API. Used to auto-provision one account
 *  per learner. `password` is generated server-side and never shown; learners
 *  authenticate for git push with a repo-scoped token instead. */
export async function createUser(
  config: GiteaConfig,
  input: { username: string; email: string; password: string },
): Promise<GiteaUser> {
  return request<GiteaUser>(config, '/admin/users', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      password: input.password,
      must_change_password: false,
    }),
  });
}

/** Fetch a user by username (returns `undefined` on 404). */
export async function getUser(
  config: GiteaConfig,
  username: string,
): Promise<GiteaUser | undefined> {
  try {
    return await request<GiteaUser>(config, `/users/${encodeURIComponent(username)}`);
  } catch (err) {
    if (err instanceof GiteaClientError && err.status === 404) return undefined;
    throw err;
  }
}

/** Create a scoped access token for a user (admin API). Returns the raw token
 *  value, which Gitea exposes exactly once on creation. */
export async function createAccessToken(
  config: GiteaConfig,
  username: string,
  name: string,
  scopes: string[],
): Promise<{ token: string; lastEight: string }> {
  const res = await request<GiteaAccessToken>(
    config,
    `/users/${encodeURIComponent(username)}/tokens`,
    {
      method: 'POST',
      headers: adminBasicHeaders(config),
      body: JSON.stringify({ name, scopes }),
    },
  );
  const token = res.sha1 ?? res.token;
  if (!token) {
    throw new GiteaClientError(`Gitea createAccessToken returned no token for ${username}`);
  }
  return { token, lastEight: res.token_last_eight ?? token.slice(-8) };
}

/** Fetch a repo by `owner/repo` (returns undefined on 404). */
export async function getRepo(
  config: GiteaConfig,
  fullName: string,
): Promise<GiteaRepo | undefined> {
  try {
    return await request<GiteaRepo>(config, `/repos/${encodeFullName(fullName)}`);
  } catch (err) {
    if (err instanceof GiteaClientError && err.status === 404) return undefined;
    throw err;
  }
}

/** Fetch a commit by full SHA. */
export async function getCommit(
  config: GiteaConfig,
  fullName: string,
  sha: string,
): Promise<GiteaCommit> {
  return request<GiteaCommit>(
    config,
    `/repos/${encodeFullName(fullName)}/git/commits/${encodeURIComponent(sha)}`,
  );
}

/** Fetch the raw unified diff of a commit (Gitea's `git/commits/{sha}.diff` endpoint). */
export async function getCommitDiff(
  config: GiteaConfig,
  fullName: string,
  sha: string,
): Promise<string> {
  const url = `${config.baseUrl}/api/v1/repos/${encodeFullName(fullName)}/git/commits/${encodeURIComponent(sha)}.diff`;
  const res = await fetch(url, { headers: { Authorization: `token ${config.token}` } });
  if (!res.ok) {
    throw new GiteaClientError(
      `Gitea commit diff ${fullName}@${sha} failed (${res.status})`,
      res.status,
    );
  }
  return res.text();
}

/** Post a CI-style commit status back to Gitea (e.g. lightweight push feedback). */
export async function createCommitStatus(
  config: GiteaConfig,
  fullName: string,
  sha: string,
  input: GiteaCommitStatusInput,
): Promise<void> {
  await request<unknown>(
    config,
    `/repos/${encodeFullName(fullName)}/statuses/${encodeURIComponent(sha)}`,
    {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        state: input.state,
        ...(input.description ? { description: input.description } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      }),
    },
  );
}

/** Deduplicated changed-file list from a commit's `files` array. */
export function listCommitFiles(commit: GiteaCommit): GiteaCommitFile[] {
  const seen = new Set<string>();
  const out: GiteaCommitFile[] = [];
  for (const file of commit.files ?? []) {
    if (!file?.filename || seen.has(file.filename)) continue;
    seen.add(file.filename);
    out.push(file);
  }
  return out;
}

/** Fetch a branch's HEAD commit id. */
export async function getBranch(
  config: GiteaConfig,
  fullName: string,
  branch: string,
): Promise<GiteaBranch> {
  return request<GiteaBranch>(
    config,
    `/repos/${encodeFullName(fullName)}/branches/${encodeURIComponent(branch)}`,
  );
}

/** List every blob path in the repo at a ref (recursive git tree). Used to
 *  locate files by suffix (e.g. `main_pages.json`) when the exact path is not
 *  known ahead of time. */
export async function listRepoTree(
  config: GiteaConfig,
  fullName: string,
  ref: string,
): Promise<string[]> {
  const res = await request<{ tree?: { path?: string; type?: string }[] }>(
    config,
    `/repos/${encodeFullName(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=true`,
  );
  return (res?.tree ?? [])
    .filter(
      (e): e is { path: string; type: string } => e?.type === 'blob' && typeof e.path === 'string',
    )
    .map((e) => e.path);
}

/**
 * Fetch a file's raw contents at a ref. Gitea returns the `content` field
 * base64-encoded. The raw `Buffer` (decoded) is returned; throws when the path
 * does not exist at the ref.
 */
export async function getFileContent(
  config: GiteaConfig,
  fullName: string,
  path: string,
  ref: string,
): Promise<GiteaFileContent> {
  const res = await request<GiteaFileContent>(
    config,
    `/repos/${encodeFullName(fullName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
  );
  if (!res || typeof res.content !== 'string') {
    throw new GiteaClientError(`Gitea file content missing for ${fullName}:${path}@${ref}`);
  }
  return res;
}

/**
 * Decode a base64 Gitea file-content `content` field into a UTF-8 string.
 * Kept here (not on the type) so the raw Buffer can be fetched when needed.
 */
export function decodeFileContent(file: GiteaFileContent): string {
  return Buffer.from(file.content, 'base64').toString('utf8');
}
