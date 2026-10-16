/**
 * PBL v2 — Git bridge provisioning (fork-on-enrollment).
 *
 * Turns an OpenMAIC `(ownerId, stageId)` project into a ready-to-push learner
 * repo: a per-project Gitea service account, a fork of the template, a push
 * webhook, and a repo-scoped access token embedded in a clone URL. This is the
 * "供给" half of the Git bridge — the read + feedback half
 * (`gitea-client.ts`) already exists.
 *
 * The account is per PROJECT rather than per human because Gitea allows only
 * one fork of a source repo per user; a learner with several projects forking
 * the same template therefore gets one namespace (and one fork) per project.
 *
 * Idempotency lives on two levels:
 *   - the registry (`lib/persistence/pbl-repo-registry.ts`) is the primary
 *     guard: a re-enroll for a known `(ownerId, stageId)` returns the stored
 *     row without touching Gitea;
 *   - this module reuses an existing Gitea account / fork on a partial-failure
 *     retry, so a crash after account creation but before the registry write
 *     does not double-create (a concurrent create/fork race is also re-read
 *     and reused).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { GiteaConfig } from './types';
import {
  createAccessToken,
  createFork,
  createUser,
  createWebhook,
  getRepo,
  getUser,
} from './gitea-client';

/** The repo name every fork takes under its per-project account (stable, readable). */
export const LEARNER_REPO_NAME = 'arkts-pbl';

/** Token scope that lets a learner clone + push their own fork. */
const REPO_WRITE_SCOPES = ['write:repository'];

/** Stable prefix for the repo-scoped token name shown in the Gitea UI. */
const LEARNER_TOKEN_NAME = 'openmaic-pbl';

/** A unique per-mint token name. Gitea enforces unique token names per user and
 *  never re-exposes a token value, so a re-provisioning mint cannot reuse the
 *  fixed name; the registry stores the token *value*, not the name. */
function mintTokenName(): string {
  return `${LEARNER_TOKEN_NAME}-${randomBytes(3).toString('hex')}`;
}

/**
 * Derive a stable, printable Gitea username for one (learner, PBL project).
 *
 * The account key is `(ownerId, stageId)` — one service account per PROJECT,
 * not per human. Gitea permits only one fork of a given source repo per user,
 * so a learner running several projects (each a distinct stage forking the same
 * template) cannot hold them under a single account. Per-project accounts give
 * each fork its own namespace while keeping the readable repo name. These are
 * bot credentials: the password is generated server-side and never shown; the
 * learner only ever receives a repo-scoped token.
 *
 * Deterministic so a crash-retry re-resolves the same account. The two hash
 * segments let an operator eyeball the learner and the project in the Gitea UI.
 * The registry stores the username as first provisioned and never re-derives.
 */
export function deriveGiteaUsername(ownerId: string, stageId: string): string {
  const ownerPart = createHash('sha256').update(ownerId, 'utf8').digest('hex').slice(0, 8);
  const stagePart = createHash('sha256').update(stageId, 'utf8').digest('hex').slice(0, 8);
  return `stu-${ownerPart}-${stagePart}`;
}

/** Embed `username:token` credentials into a Gitea clone URL so DevEco / git
 *  can clone and push without prompting. Falls back to the unmodified URL when
 *  it does not start with an `http(s)://` scheme. */
export function embedCloneCredentials(cloneUrl: string, username: string, token: string): string {
  const match = /^(https?:\/\/)(.*)$/.exec(cloneUrl);
  if (!match) return cloneUrl;
  return `${match[1]}${encodeURIComponent(username)}:${encodeURIComponent(token)}@${match[2]}`;
}

/** The provisioned repo the registry persists and the enroll route returns. */
export interface ProvisionedRepo {
  giteaUsername: string;
  repoFullName: string;
  cloneUrl: string;
  htmlUrl: string | null;
  token: string;
  tokenLastEight: string;
}

export interface ProvisionLearnerRepoInput {
  config: GiteaConfig;
  ownerId: string;
  /** The PBL project (stage) this fork is for; drives the per-project repo name. */
  stageId: string;
}

/**
 * Ensure one learner Gitea account + template fork + push webhook + repo-scoped
 * token. Idempotent against Gitea as described above. The raw token is returned
 * once (on first provisioning) — the caller must persist it, because Gitea
 * never exposes the token value again.
 */
export async function provisionLearnerRepo(
  input: ProvisionLearnerRepoInput,
): Promise<ProvisionedRepo> {
  const { config, ownerId, stageId } = input;
  const username = deriveGiteaUsername(ownerId, stageId);

  // 1. Account — create if absent. A concurrent create surfaces as an error,
  //    so re-read on any create failure before giving up.
  if (!(await getUser(config, username))) {
    try {
      await createUser(config, {
        username,
        email: `${username}@openmaic.local`,
        password: randomBytes(24).toString('base64url'),
      });
    } catch (error) {
      if (!(await getUser(config, username))) throw error;
    }
  }

  // 2. Per-learner repo-scoped token. Acts as the learner for the fork below:
  //    Gitea forks into the authenticated user's namespace, and the admin
  //    token has no impersonation endpoint, so the fork must run under the
  //    learner's own credential.
  const { token, lastEight } = await createAccessToken(
    config,
    username,
    mintTokenName(),
    REPO_WRITE_SCOPES,
  );

  // 3. Fork the template into the learner's namespace using their token.
  const learnerConfig: GiteaConfig = { ...config, token };
  const forkFullName = `${username}/${LEARNER_REPO_NAME}`;
  let fork = await getRepo(learnerConfig, forkFullName);
  if (!fork) {
    try {
      fork = await createFork(learnerConfig, { name: LEARNER_REPO_NAME });
    } catch (error) {
      // A concurrent enrollment may have forked between our read and create;
      // reuse the raced fork rather than failing the retry.
      const raced = await getRepo(learnerConfig, forkFullName);
      if (raced) fork = raced;
      else throw error;
    }
  }

  // 4. Push webhook on the fork, registered with the admin token (which may
  //    manage any repo's hooks). Best-effort: push feedback degrades, but
  //    enrollment must not fail on a webhook race.
  if (config.webhookUrl) {
    try {
      await createWebhook(config, fork.full_name, config.webhookUrl, config.webhookSecret);
    } catch (error) {
      console.warn(`[provision] webhook registration failed for ${fork.full_name}`, error);
    }
  }

  const cloneUrl = fork.clone_url
    ? embedCloneCredentials(fork.clone_url, username, token)
    : embedCloneCredentials(`${config.baseUrl}/${fork.full_name}.git`, username, token);

  return {
    giteaUsername: username,
    repoFullName: fork.full_name,
    cloneUrl,
    htmlUrl: fork.html_url ?? null,
    token,
    tokenLastEight: lastEight,
  };
}
