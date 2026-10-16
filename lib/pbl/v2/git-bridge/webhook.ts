/**
 * PBL v2 — Git bridge webhook parsing & signature verification.
 *
 * Pure functions only (no env, no network): they take a raw body / header /
 * secret as arguments so they are trivially unit-testable. The HTTP route
 * reads the request and delegates here.
 *
 * Gitea signs push webhooks with HMAC-SHA256 over the raw request body, hex
 * encoded, delivered in the `X-Gitea-Signature` header.
 */

import crypto from 'crypto';
import type { GiteaPushWebhook } from './types';

/**
 * Constant-time HMAC-SHA256 signature check.
 *
 * @param secret  shared webhook secret (empty ⇒ signature is not checked)
 * @param rawBody raw request body bytes (string)
 * @param signature value of the `X-Gitea-Signature` header (hex digest)
 */
export function verifyGiteaSignature(
  secret: string,
  rawBody: string,
  signature: string | undefined | null,
): boolean {
  if (!secret) {
    // No shared secret configured ⇒ verification is intentionally skipped.
    return true;
  }
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signature.trim(), 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Parse a Gitea push webhook payload into the subset the bridge consumes.
 * Returns `undefined` when the payload is not a push event or is missing the
 * fields the bridge depends on.
 */
export function parseGiteaPushWebhook(body: unknown): GiteaPushWebhook | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;

  // The Gitea webhook `X-Gitea-Event` header is the authoritative event type;
  // the route already filters to `push`. Here we only guard the payload shape.
  const ref = typeof b.ref === 'string' ? b.ref : undefined;
  const after = typeof b.after === 'string' ? b.after : undefined;
  if (!ref || !after) return undefined;
  if (!ref.startsWith('refs/heads/')) return undefined;

  const before = typeof b.before === 'string' ? b.before : '';
  const commits = Array.isArray(b.commits) ? b.commits : undefined;
  const repo =
    typeof b.repository === 'object' && b.repository !== null
      ? (b.repository as Record<string, unknown>)
      : undefined;
  const owner = repo?.owner as Record<string, unknown> | undefined;
  const pusher =
    typeof b.pusher === 'object' && b.pusher !== null
      ? (b.pusher as Record<string, unknown>)
      : undefined;

  return {
    ref,
    before,
    after,
    commits: commits?.map((c) => {
      const commit = c as Record<string, unknown>;
      return {
        id: typeof commit.id === 'string' ? commit.id : '',
        ...(typeof commit.message === 'string' ? { message: commit.message } : {}),
        ...(typeof commit.timestamp === 'string' ? { timestamp: commit.timestamp } : {}),
        ...(Array.isArray(commit.added)
          ? { added: commit.added.filter((p): p is string => typeof p === 'string') }
          : {}),
        ...(Array.isArray(commit.removed)
          ? { removed: commit.removed.filter((p): p is string => typeof p === 'string') }
          : {}),
        ...(Array.isArray(commit.modified)
          ? { modified: commit.modified.filter((p): p is string => typeof p === 'string') }
          : {}),
      };
    }),
    repository: {
      ...(typeof repo?.full_name === 'string' ? { full_name: repo.full_name } : {}),
      ...(typeof owner?.login === 'string' ? { owner: { login: owner.login } } : {}),
    },
    ...(typeof pusher?.login === 'string' ? { pusher: { login: pusher.login } } : {}),
  };
}

/**
 * Union of all changed paths across the push's commits, de-duplicated and
 * sorted for stable snapshots. Only added/modified/removed files are included
 * (renames are represented by an added + removed pair in Gitea's payload).
 */
export function listChangedFiles(webhook: GiteaPushWebhook): string[] {
  const seen = new Set<string>();
  for (const commit of webhook.commits ?? []) {
    for (const path of [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ]) {
      if (path) seen.add(path);
    }
  }
  return [...seen].sort();
}
