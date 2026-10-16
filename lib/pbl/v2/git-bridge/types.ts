/**
 * PBL v2 — Git bridge types.
 *
 * Self-hosted Gitea is the first (and currently only) Git host. These types
 * cover (a) the server-side Gitea connection config and (b) the shape of a
 * Gitea push webhook payload, parsed/verified by {@link webhook.ts}.
 */

/** Server-side Gitea connection. Resolved from the environment by
 *  {@link getGiteaConfig}; absent when the integration is not configured. */
export interface GiteaConfig {
  /** Normalized base URL, no trailing slash (e.g. `http://127.0.0.1:3000`). */
  baseUrl: string;
  /** Personal access token with admin scope: used to create learner accounts,
   *  fork the template, and register push webhooks (provisioning), and with
   *  repo + webhook write scope for the read/feedback paths. Held server-side
   *  only; never handed to learners. */
  token: string;
  /** Admin account login used to mint per-learner repo tokens via Basic auth.
   *  Gitea's token-creation endpoint (`POST /users/{username}/tokens`) rejects
   *  API-token auth, so provisioning needs the admin's username+password in
   *  addition to {@link token}. Optional: the read/feedback paths only need
   *  `token`. */
  adminUser?: string;
  /** Admin account password for {@link adminUser} (Basic auth). Server-side
   *  only; never handed to learners. */
  adminPassword?: string;
  /** Template repo learners fork from (owner/repo). */
  templateFullName: string;
  /** HMAC-SHA256 secret used to sign/verify push webhooks. */
  webhookSecret: string;
  /** Public base URL of this OpenMAIC instance's push webhook receiver
   *  (e.g. `http://host:3001/api/pbl/v2/git/webhook`), used to register a
   *  push webhook on each learner fork during provisioning. Optional: absent
   *  when the webhook receiver is not exposed, in which case provisioning
   *  skips webhook registration. */
  webhookUrl?: string;
}

/** One commit in a Gitea push webhook. */
export interface GiteaPushCommit {
  id: string;
  message?: string;
  timestamp?: string;
  /** Paths added in this commit (relative to repo root). */
  added?: string[];
  /** Paths removed in this commit. */
  removed?: string[];
  /** Paths modified in this commit. */
  modified?: string[];
}

/** The subset of a Gitea push webhook payload the bridge consumes. */
export interface GiteaPushWebhook {
  /** e.g. `refs/heads/main`. */
  ref: string;
  /** Commit SHA the push moved from (all-zero on a new branch). */
  before: string;
  /** Commit SHA the push moved to — the SHA a "pinned" submission targets. */
  after: string;
  commits?: GiteaPushCommit[];
  repository?: {
    full_name?: string;
    owner?: { login?: string };
  };
  pusher?: { login?: string };
}

/** One changed file in a Gitea commit. */
export interface GiteaCommitFile {
  filename: string;
  /** `added` | `modified` | `removed` | `renamed`. */
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

/** Gitea API commit object (subset used to fetch a snapshot / diff). */
export interface GiteaCommit {
  sha: string;
  message?: string;
  created?: string;
  files?: GiteaCommitFile[];
}

/** A commit-status check posted back to Gitea (CI-style feedback surface). */
export type GiteaCommitStatusState = 'pending' | 'success' | 'error' | 'failure' | 'warning';

export interface GiteaCommitStatusInput {
  state: GiteaCommitStatusState;
  description?: string;
  /** Short context label shown in the Gitea UI (e.g. `openmaic/pbl`). */
  context?: string;
  targetUrl?: string;
}

/** Gitea API file-content object at a given ref. */
export interface GiteaFileContent {
  path: string;
  /** Base64-encoded content (Gitea returns `content` base64'd). */
  content: string;
  encoding?: string;
  size?: number;
}

/** Gitea API repository object (subset). */
export interface GiteaRepo {
  id: number;
  full_name: string;
  clone_url?: string;
  ssh_url?: string;
  html_url?: string;
  empty?: boolean;
  fork?: boolean;
  parent?: { full_name?: string };
}

/** Gitea API branch object (subset). */
export interface GiteaBranch {
  name: string;
  commit?: { id?: string };
}

/** Gitea API user object (subset). */
export interface GiteaUser {
  id: number;
  login: string;
  email?: string;
}

/** Gitea API access-token object (subset). The raw token value is returned
 *  exactly once on creation, under `sha1` (Gitea's historical field name) or
 *  `token`; callers read whichever is present. */
export interface GiteaAccessToken {
  id?: number;
  name?: string;
  sha1?: string;
  token?: string;
  token_last_eight?: string;
}
