/**
 * PBL v2 — client-side Git bridge helpers.
 *
 * Thin `fetch` wrappers over the PBL git routes, shared by the workspace top
 * bar (repo enrollment / status) and the submission modal ("提交评判" pin-SHA
 * diff preview). Mirrors the rest of the PBL client: raw `fetch` with the
 * same-origin anonymous cookie for owner identity — no shared HTTP wrapper.
 *
 * Response shapes mirror the server routes (see each route file):
 *   - `/git/repo`  → `{ repo: RepoView | null }` (raw body, owner-scoped)
 *   - `/git/enroll` → `RepoView` (raw body, owner-scoped)
 *   - `/git/diff`  → `{ success: true, ...CommitDiff }` (stateless)
 * All non-2xx throw `Error` carrying the server's human-readable `error`.
 */

/** Flat public view of a provisioned learner fork (mirror of `PBLRepoPublicView`). */
export interface RepoView {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string | null;
  username: string;
  token: string;
  tokenLastEight: string | null;
  stageId: string;
  domainId: string | null;
}

/** One changed file in a commit (mirror of `GiteaCommitFile`). */
export interface CommitFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

export interface CommitDiff {
  fullName: string;
  sha: string;
  commit: {
    sha: string;
    message: string;
    created?: string;
  };
  changedFiles: CommitFile[];
  diff: string;
}

async function readError(res: Response): Promise<Error> {
  let message = `请求失败（${res.status}）`;
  try {
    const body = (await res.json()) as { error?: string; errorCode?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body — keep the status-only message.
  }
  return new Error(message);
}

/** Read-only status of the learner's fork, or `null` when not enrolled yet. */
export async function fetchRepo(stageId: string): Promise<RepoView | null> {
  const res = await fetch(`/api/pbl/v2/git/repo?stageId=${encodeURIComponent(stageId)}`);
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { repo?: RepoView | null };
  return body?.repo ?? null;
}

/** Fork-on-enrollment; idempotent. Returns the (possibly existing) fork. */
export async function enrollRepo(input: {
  stageId: string;
  sceneId?: string;
  domainId?: string;
}): Promise<RepoView> {
  const res = await fetch('/api/pbl/v2/git/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as RepoView;
}

/** Server-side commit diff fetch for the "提交评判" preview (client never holds the token). */
export async function fetchCommitDiff(fullName: string, sha: string): Promise<CommitDiff> {
  const res = await fetch('/api/pbl/v2/git/diff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName, sha }),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as CommitDiff & { success?: boolean };
  return body;
}
