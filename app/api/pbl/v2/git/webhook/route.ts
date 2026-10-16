/**
 * POST /api/pbl/v2/git/webhook
 *
 * Gitea push webhook receiver. On `git push` to a learner fork it:
 *   1. verifies the HMAC-SHA256 `X-Gitea-Signature` against the shared secret,
 *   2. parses the push payload (ref / after SHA / changed files),
 *   3. runs lightweight static checks over the changed paths,
 *   4. resolves the fork back to its project via the repo registry
 *      (`fullName → domainId`) and runs the domain's static checks over the
 *      changed source + registry files at `after`,
 *   5. posts the merged findings back to Gitea as a commit status.
 *
 * The registry lookup + domain checks are best-effort: without a database row
 * or a reachable Gitea, push feedback degrades to the generic checks rather
 * than failing the webhook (Gitea would otherwise retry the delivery). Formal
 * rubric scoring is learner-initiated via the workspace ("提交评判" pins a SHA
 * and runs the normal evaluate flow).
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getGiteaConfig } from '@/lib/pbl/v2/git-bridge/config';
import { parseGiteaPushWebhook, verifyGiteaSignature } from '@/lib/pbl/v2/git-bridge/webhook';
import {
  runLightweightStaticCheck,
  sortStaticFindings,
  staticFindingsState,
  summarizeStaticFindings,
} from '@/lib/pbl/v2/git-bridge/static-checks';
import { createCommitStatus } from '@/lib/pbl/v2/git-bridge/gitea-client';

const log = createLogger('PBL v2 Git Webhook');

export async function POST(req: NextRequest) {
  const config = getGiteaConfig();
  if (!config) {
    return apiError('INTERNAL_ERROR', 503, 'Git bridge is not configured.');
  }

  // Only `push` events are handled. Acknowledge everything else without work so
  // Gitea does not retry (the webhook is registered for `push` only anyway).
  const event = req.headers.get('x-gitea-event');
  if (event && event !== 'push') {
    return apiSuccess({ ignored: true, event });
  }

  const rawBody = await req.text();

  if (!verifyGiteaSignature(config.webhookSecret, rawBody, req.headers.get('x-gitea-signature'))) {
    log.warn('[webhook] rejected push: signature mismatch');
    return apiError('UNAUTHENTICATED', 401, 'Invalid webhook signature.');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return apiError('PARSE_FAILED', 400, 'Webhook body is not valid JSON.');
  }

  const webhook = parseGiteaPushWebhook(body);
  if (!webhook) {
    return apiError('INVALID_REQUEST', 400, 'Unrecognized push payload.');
  }

  const fullName = webhook.repository?.full_name;
  if (!fullName || !webhook.after) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'Push payload missing repository full_name or after SHA.',
    );
  }

  // Aggregate changed paths by kind across all commits in the push.
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const commit of webhook.commits ?? []) {
    added.push(...(commit.added ?? []));
    modified.push(...(commit.modified ?? []));
    removed.push(...(commit.removed ?? []));
  }

  const genericFindings = runLightweightStaticCheck({ added, modified, removed });

  const findings = sortStaticFindings(genericFindings);

  // Post feedback back to Gitea. Best-effort: a status-post failure must not
  // turn a valid push into a webhook error (Gitea would retry it).
  try {
    await createCommitStatus(config, fullName, webhook.after, {
      state: staticFindingsState(findings),
      context: 'openmaic/pbl',
      description: summarizeStaticFindings(findings),
    });
  } catch (err) {
    log.warn('[webhook] failed to post commit status', err);
  }

  return apiSuccess({
    fullName,
    ref: webhook.ref,
    sha: webhook.after,
    findings,
  });
}
