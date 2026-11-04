import 'server-only';

import { createHash } from 'node:crypto';

import {
  sandboxConfigurationSchema,
  legacySandboxConfiguration,
} from '@/lib/sandbox/config-schema';
import { SandboxError } from '@/lib/sandbox/errors';

export interface SandboxConfig {
  /** Persisted settings revision; zero means deployment environment. */
  settingsRevision?: number;
  connectionId: string;
  fingerprint: string;
  apiKey: string;
  domain: string;
  apiUrl: string;
  template: string;
  desktopTemplate?: string;
  lifetimeMs: number;
  maxActivePerOwner: number;
  maxActive: number;
}

/** Validate the effective layer once more before handing it to the SDK. */
export function sandboxConfigFromConfiguration(value: unknown): SandboxConfig {
  const parsed = sandboxConfigurationSchema.safeParse(value);
  if (!parsed.success)
    throw new SandboxError(
      'SANDBOX_CONFIG_INVALID',
      503,
      'Sandbox deployment configuration is invalid.',
    );
  const config = parsed.data;
  if (!config.enabled)
    throw new SandboxError('SANDBOX_DISABLED', 503, 'Sandbox provider is not configured.');
  const { connectionId, domain, template, apiKey, lifetimeMs, maxActive, maxActivePerOwner } =
    config;
  const apiUrl = new URL(config.apiUrl).origin;
  const desktopTemplate = config.desktopTemplate || undefined;
  return {
    connectionId,
    domain,
    apiUrl,
    template,
    desktopTemplate,
    apiKey,
    lifetimeMs,
    maxActive,
    maxActivePerOwner,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([connectionId, apiUrl, domain, template, desktopTemplate]))
      .digest('hex'),
  };
}

/** Compatibility entry point for tools that still supply the legacy variables directly. */
export function sandboxConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxConfig {
  if (env.E2B_SANDBOX_URL || env.E2B_ACCESS_TOKEN)
    throw new SandboxError(
      'SANDBOX_CONFIG_INVALID',
      503,
      'Sandbox deployment configuration is invalid.',
    );
  return sandboxConfigFromConfiguration(legacySandboxConfiguration(env) ?? {});
}
