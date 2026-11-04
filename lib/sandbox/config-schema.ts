import { z } from 'zod';

const endpoint = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    } catch {
      return false;
    }
  }, 'expected an HTTPS origin without credentials, path, query or fragment');
const template = z
  .string()
  .trim()
  .max(256)
  .regex(/^[^\s\x00-\x1f]*$/, 'invalid template ID');

/** One shape for deployment defaults and installation web overrides. */
export const sandboxFieldsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('e2b-compatible'),
    connectionId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,128}$/, 'invalid connection ID'),
    apiUrl: endpoint,
    domain: z
      .string()
      .trim()
      .max(253)
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        'expected a runtime domain without a scheme or path',
      ),
    template,
    desktopTemplate: template,
    lifetimeMs: z.number().int().min(60_000).max(3_600_000),
    maxActive: z.number().int().min(1).max(100),
    maxActivePerOwner: z.number().int().min(1).max(20),
  })
  .strict();

export const sandboxDefaults = {
  enabled: false,
  provider: 'e2b-compatible' as const,
  connectionId: 'my-installation',
  apiUrl: 'https://api.e2b.dev',
  domain: 'e2b.app',
  template: '',
  desktopTemplate: '',
  lifetimeMs: 300_000,
  maxActive: 5,
  maxActivePerOwner: 1,
};

export const sandboxConfigurationSchema = sandboxFieldsSchema
  .partial()
  .extend({
    apiKey: z.string().trim().max(4096).optional(),
  })
  .transform((input) => ({
    ...sandboxDefaults,
    ...input,
    apiUrl:
      input.apiUrl ?? (input.domain && input.domain !== 'e2b.app' ? '' : sandboxDefaults.apiUrl),
    apiKey: input.apiKey ?? '',
  }))
  .superRefine((config, ctx) => {
    if (config.maxActivePerOwner > config.maxActive)
      ctx.addIssue({
        code: 'custom',
        path: ['maxActivePerOwner'],
        message: 'must not exceed maxActive',
      });
    if (config.enabled) {
      for (const field of ['apiUrl', 'template', 'apiKey'] as const)
        if (!config[field])
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'required when sandbox.enabled is true',
          });
    }
  });
export type SandboxConfiguration = z.output<typeof sandboxConfigurationSchema>;

/** No YAML means the existing variables feed the same deployment shape. */
export function legacySandboxConfiguration(env: Readonly<Record<string, string | undefined>>) {
  const mapping = {
    provider: 'PROVIDER',
    connectionId: 'CONNECTION_ID',
    apiUrl: 'API_URL',
    domain: 'DOMAIN',
    template: 'TEMPLATE',
    desktopTemplate: 'DESKTOP_TEMPLATE',
    apiKey: 'API_KEY',
    lifetimeMs: 'LIFETIME_MS',
    maxActive: 'MAX_ACTIVE',
    maxActivePerOwner: 'MAX_ACTIVE_PER_OWNER',
  } as const;
  if (!env.OPENMAIC_SANDBOX_PROVIDER?.trim()) return undefined;
  const value: Record<string, unknown> = { enabled: true };
  for (const [key, suffix] of Object.entries(mapping)) {
    const raw = env[`OPENMAIC_SANDBOX_${suffix}`]?.trim();
    if (raw)
      value[key] = ['lifetimeMs', 'maxActive', 'maxActivePerOwner'].includes(key)
        ? /^\d+$/.test(raw)
          ? Number(raw)
          : NaN
        : raw;
  }
  // Preserve the requirement for a stable account identifier on legacy deployments.
  value.connectionId ??= '';
  return value;
}
