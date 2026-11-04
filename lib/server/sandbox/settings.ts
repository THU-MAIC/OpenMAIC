import 'server-only';
import { z } from 'zod';
import type { Queryable } from '@openmaic/storage/document/pg';
import { provisionSandboxEnvironmentSchema } from '@/lib/persistence/sandbox-environments';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  isPersonalInstallationOwner,
  OWNER_ROLES,
  type OwnerPrincipal,
} from '@/lib/server/identity';
import { sealSecret, openSecret, type SealedSecret } from '@/lib/server/secret-box';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import type { SandboxSettingsFields, SandboxSettingsView } from '@/lib/sandbox/settings';
import { sandboxConfigFromConfiguration } from './config';
import { sandboxDefaults, sandboxFieldsSchema } from '@/lib/sandbox/config-schema';
import { deploymentConfig } from '@/lib/server/model-config/runtime';
import { previewConfig } from './preview';
import { CheckpointStorage } from './checkpoint-storage';

const CONTEXT = 'sandbox-installation-key:v1';
function deployment() {
  const config = deploymentConfig().layer?.config;
  const { apiKey, ...fields } = { ...sandboxDefaults, apiKey: '', ...config?.sandbox };
  return {
    fields,
    key: apiKey,
    locked: config?.lock === 'all' || !!config?.lock?.includes('sandbox'),
  };
}
function assertWritable() {
  if (deployment().locked)
    throw new SandboxError(
      'SANDBOX_SETTINGS_LOCKED',
      403,
      'Sandbox configuration is locked by the deployment.',
    );
}
export function assertSandboxSettingsAdmin(principal: OwnerPrincipal) {
  if (isPersonalInstallationOwner(principal)) return;
  if (
    (principal.kind === 'user' || principal.kind === 'service') &&
    principal.assurance === 'verified' &&
    principal.roles.has(OWNER_ROLES.admin)
  )
    return;
  throw new SandboxError(
    'SANDBOX_SETTINGS_FORBIDDEN',
    403,
    'Only the installation administrator can configure sandboxes.',
  );
}
export const sandboxSettingsInput = z.union([
  z
    .object({
      revision: z.number().int().nonnegative(),
      fields: sandboxFieldsSchema.refine((f) => f.maxActivePerOwner <= f.maxActive),
      apiKey: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ revision: z.number().int().nonnegative(), reset: z.literal(true) }).strict(),
]);
interface Row {
  config: Partial<SandboxSettingsFields>;
  secret: SealedSecret | null;
  revision: number;
}
async function persistence() {
  if (!process.env.DATABASE_URL)
    throw new SandboxError(
      'SANDBOX_STORAGE_UNAVAILABLE',
      503,
      'Configure a database before saving sandbox settings.',
    );
  const p = await getServerPersistenceProvider(process.env.DATABASE_URL);
  await provisionSandboxEnvironmentSchema(p.pool);
  return p;
}
async function readRow(q: Queryable) {
  return (
    await q.query<Row & Record<string, unknown>>(
      'SELECT config,secret,revision FROM sandbox_settings WHERE id=1',
    )
  ).rows[0];
}
function unpack(row?: Row) {
  const base = deployment();
  const override = base.locked ? undefined : row;
  const fields = { ...base.fields, ...override?.config };
  const sameConnection = (['connectionId', 'apiUrl', 'domain'] as const).every(
    (key) => fields[key] === base.fields[key],
  );
  // Never inherit a deployment credential into a different saved endpoint/account.
  let key = sameConnection ? base.key : '',
    unreadable = false;
  if (override?.secret) {
    try {
      key = openSecret(override.secret, CONTEXT);
    } catch {
      key = '';
      unreadable = true;
    }
  }
  return {
    fields,
    key,
    unreadable,
    revision: row?.revision ?? 0,
    hasOverrides: !!override && (!!override.secret || Object.keys(override.config).length > 0),
    locked: base.locked,
  };
}
function runtimeConfig(fields: SandboxSettingsFields, apiKey: string) {
  // Block SDK globals even if sandboxes are enabled only through web settings.
  if (process.env.E2B_SANDBOX_URL || process.env.E2B_ACCESS_TOKEN)
    throw new SandboxError('SANDBOX_CONFIG_INVALID', 503, 'Unset SDK data-plane overrides.');
  return sandboxConfigFromConfiguration({ ...fields, apiKey });
}
/** Deployment defaults, then installation overrides unless the deployment locks sandbox. */
export async function resolvedSandboxConfig() {
  const row = deployment().locked ? undefined : await readRow((await persistence()).pool);
  const value = unpack(row);
  if (value.unreadable)
    throw new SandboxError('SANDBOX_KEY_UNREADABLE', 503, 'Re-enter the sandbox key in Settings.');
  return {
    ...runtimeConfig(value.fields, value.key),
    settingsRevision: value.locked ? 0 : value.revision,
  };
}
export async function sandboxWorkspaceEnabled() {
  if (!process.env.DATABASE_URL) return false;
  const row = deployment().locked ? undefined : await readRow((await persistence()).pool);
  return unpack(row).fields.enabled;
}
async function activeCount(q: Queryable) {
  return Number(
    (
      await q.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM sandbox_environments WHERE state <> 'destroyed'",
      )
    ).rows[0].count,
  );
}
export async function sandboxSettingsView(): Promise<SandboxSettingsView> {
  const p = await persistence(),
    row = await readRow(p.pool),
    value = unpack(row);
  let configured = false,
    previewConfigured = false;
  try {
    runtimeConfig(value.fields, value.key);
    configured = true;
  } catch {
    /* reported as not configured */
  }
  try {
    previewConfig();
    previewConfigured = true;
  } catch {
    /* optional */
  }
  return {
    revision: value.revision,
    source: value.hasOverrides ? 'settings' : 'deployment',
    locked: value.locked,
    hasOverrides: value.hasOverrides,
    fields: value.fields,
    keySet: !!value.key || value.unreadable,
    keyUnreadable: value.unreadable,
    configured,
    activeEnvironments: await activeCount(p.pool),
    previewConfigured,
    checkpointConfigured: await new CheckpointStorage(p, async () => {
      throw new Error('Configuration probe cannot mutate checkpoints.');
    }).available(),
  };
}
/** Called under the SAME capacity lock as settings writes, before any paid create. */
export async function assertSandboxSettingsRevision(q: Queryable, revision: number) {
  if (deployment().locked) {
    if (revision !== 0)
      throw sandboxConflict('Sandbox configuration is now locked. Refresh and try again.');
    return;
  }
  if (((await readRow(q))?.revision ?? 0) !== revision)
    throw sandboxConflict('Sandbox settings changed. Refresh and try again.');
}
export async function saveSandboxSettings(raw: unknown) {
  assertWritable();
  const parsed = sandboxSettingsInput.safeParse(raw);
  if (!parsed.success) throw sandboxInvalid('Check the sandbox fields and limits.');
  const input = parsed.data,
    p = await persistence();
  await p.withTransaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('openmaic.sandbox.capacity', 0))",
    );
    const row = await readRow(tx),
      previous = unpack(row);
    if (previous.revision !== input.revision)
      throw sandboxConflict('Sandbox settings changed. Refresh before saving.');
    if (await activeCount(tx))
      throw sandboxConflict(
        'Release or reconcile all environments before changing sandbox settings.',
      );
    if ('reset' in input) {
      await writeRow(tx, {}, null, previous.revision + 1);
      return;
    }
    const connectionChanged = ['apiUrl', 'domain', 'connectionId'].some(
      (k) =>
        input.fields[k as keyof SandboxSettingsFields] !==
        previous.fields[k as keyof SandboxSettingsFields],
    );
    if (connectionChanged && !input.apiKey && (previous.key || previous.unreadable))
      throw sandboxInvalid('Enter a new key when changing the account or endpoint.');
    if (previous.unreadable && !input.apiKey && input.fields.enabled)
      throw sandboxInvalid('The saved key cannot be decrypted. Enter it again.');
    const key = input.apiKey ?? previous.key;
    if (input.fields.enabled) {
      try {
        runtimeConfig(input.fields, key);
      } catch {
        throw sandboxInvalid('A valid HTTPS API endpoint, domain, template and key are required.');
      }
    }
    // Only an explicitly supplied key becomes a sealed web override. Otherwise
    // inherit deployment credentials so rotating them does not leave a stale copy.
    const secret = input.apiKey ? sealSecret(input.apiKey, CONTEXT) : (row?.secret ?? null);
    const defaults = deployment().fields;
    const overrides: Partial<SandboxSettingsFields> = Object.fromEntries(
      Object.entries(input.fields).filter(
        ([key, value]) => value !== defaults[key as keyof SandboxSettingsFields],
      ),
    );
    // A saved key must never follow a later deployment endpoint/account change.
    if (secret)
      for (const key of ['connectionId', 'apiUrl', 'domain'] as const)
        overrides[key] = input.fields[key];
    await writeRow(tx, overrides, secret, previous.revision + 1);
  });
  return sandboxSettingsView();
}

async function writeRow(
  q: Queryable,
  config: Partial<SandboxSettingsFields>,
  secret: SealedSecret | null,
  revision: number,
) {
  await q.query(
    `INSERT INTO sandbox_settings(id,config,secret,revision) VALUES (1,$1::jsonb,$2::jsonb,$3)
    ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,secret=EXCLUDED.secret,revision=EXCLUDED.revision,updated_at=now()`,
    [JSON.stringify(config), JSON.stringify(secret), revision],
  );
}
