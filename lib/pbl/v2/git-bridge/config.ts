/**
 * PBL v2 — Git bridge server config.
 *
 * Self-hosted Gitea connection settings come from the environment. The Git
 * bridge is a server-only integration (unlike the LLM providers, there is no
 * per-client credential flow), so the config is a single env-backed singleton
 * rather than the YAML+env provider-config machinery.
 *
 * Environment variables:
 *   GITEA_URL            — base URL, e.g. `http://127.0.0.1:3000`
 *   GITEA_TOKEN          — personal access token (admin scope for provisioning)
 *   GITEA_TEMPLATE_REPO  — template repo learners fork, e.g. `goking/arkts-pbl-template`
 *   GITEA_WEBHOOK_SECRET — HMAC-SHA256 secret shared with the push webhook
 *   GITEA_WEBHOOK_URL    — public webhook receiver URL, for per-fork hook registration
 *   GITEA_ADMIN_USER     — admin login for minting learner tokens (Basic auth)
 *   GITEA_ADMIN_PASSWORD — admin password for the above (Basic auth, server-side only)
 */

import { createLogger } from '@/lib/logger';
import type { GiteaConfig } from './types';

const log = createLogger('GiteaConfig');

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

/** Parsed form of `GITEA_TEMPLATE_REPO`; the `owner/` prefix is optional. */
export function splitFullName(value: string | undefined): {
  owner: string;
  repo: string;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length === 1) return null; // owner is required to create a fork
  if (parts.length >= 2) return { owner: parts[0]!, repo: parts.slice(1).join('/') };
  return null;
}

/**
 * Resolve the Gitea connection from the environment. Returns `undefined` when
 * the integration is not configured (the Git bridge then degrades to no-op).
 */
export function getGiteaConfig(): GiteaConfig | undefined {
  const baseUrl = normalizeBaseUrl(process.env.GITEA_URL);
  const token = process.env.GITEA_TOKEN?.trim();
  const templateFullName = process.env.GITEA_TEMPLATE_REPO?.trim();
  const webhookSecret = process.env.GITEA_WEBHOOK_SECRET;
  const webhookUrl = process.env.GITEA_WEBHOOK_URL?.trim() || undefined;
  const adminUser = process.env.GITEA_ADMIN_USER?.trim() || undefined;
  const adminPassword = process.env.GITEA_ADMIN_PASSWORD;

  if (!baseUrl || !token || !templateFullName) {
    if (baseUrl || token || templateFullName) {
      log.warn(
        '[GiteaConfig] Incomplete Gitea config — set GITEA_URL, GITEA_TOKEN and GITEA_TEMPLATE_REPO together',
      );
    }
    return undefined;
  }

  return {
    baseUrl,
    token,
    templateFullName,
    webhookSecret: webhookSecret ?? '',
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(adminUser ? { adminUser } : {}),
    ...(adminPassword !== undefined ? { adminPassword } : {}),
  };
}
