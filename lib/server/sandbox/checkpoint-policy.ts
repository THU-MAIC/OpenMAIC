import 'server-only';
import { SandboxError } from '@/lib/sandbox/errors';
import { WORKSPACE_ROOT, WORKSPACE_EXCLUDES } from './workspace-archive';

export const CHECKPOINT_TIMEOUT_MS = 120_000;
export const CHECKPOINT_MIN_LIFETIME_MS = CHECKPOINT_TIMEOUT_MS + 60_000;

export interface CheckpointRoot {
  name: string;
  path: string;
  excludes: string[];
}
export interface CheckpointPolicy {
  roots: CheckpointRoot[];
  maxBytes: number;
  maxFiles: number;
}
function invalid(): never {
  throw new SandboxError(
    'SANDBOX_CHECKPOINT_CONFIG',
    503,
    'Invalid checkpoint storage configuration.',
  );
}
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value?.trim()) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return invalid();
  return n;
}
/** Only the deployment configures paths; a student/Agent cannot expand the backup scope. */
export function checkpointPolicy(
  env: Record<string, string | undefined> = process.env,
): CheckpointPolicy {
  let additional: CheckpointRoot[] = [];
  try {
    additional = JSON.parse(env.OPENMAIC_SANDBOX_CHECKPOINT_PATHS || '[]');
  } catch {
    invalid();
  }
  if (!Array.isArray(additional) || additional.length > 7) invalid();
  const roots: CheckpointRoot[] = [
    { name: 'project', path: WORKSPACE_ROOT, excludes: WORKSPACE_EXCLUDES },
    ...additional,
  ];
  for (const root of roots) {
    if (
      !root ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(root.name) ||
      typeof root.path !== 'string' ||
      !root.path.startsWith('/home/user/') ||
      root.path.length > 512 ||
      root.path.includes('\\') ||
      root.path.includes('\0') ||
      root.path
        .split('/')
        .slice(1)
        .some((p) => !p || p === '.' || p === '..') ||
      root.path.split('/').some((p) => p.startsWith('.openmaic-')) ||
      !Array.isArray(root.excludes) ||
      root.excludes.length > 32 ||
      root.excludes.some(
        (p) =>
          typeof p !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(p) || p === '.' || p === '..',
      )
    )
      invalid();
  }
  if (new Set(roots.map((r) => r.name)).size !== roots.length) invalid();
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i].path,
        b = roots[j].path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) invalid();
    }
  return {
    roots,
    maxBytes: integer(
      env.OPENMAIC_SANDBOX_CHECKPOINT_MAX_BYTES,
      256 * 1024 ** 2,
      1024,
      8 * 1024 ** 3,
    ),
    maxFiles: integer(env.OPENMAIC_SANDBOX_CHECKPOINT_MAX_FILES, 100000, 1, 1000000),
  };
}
export function checkpointOwnerQuota(env: Record<string, string | undefined> = process.env) {
  return integer(env.OPENMAIC_SANDBOX_CHECKPOINT_OWNER_BYTES, 2 * 1024 ** 3, 1024, 1024 ** 4);
}
export function checkpointPrefix(env: Record<string, string | undefined> = process.env) {
  const prefix = env.OPENMAIC_SANDBOX_CHECKPOINT_PREFIX?.trim() || 'sandbox-checkpoints/v1/';
  if (!/^(?:[A-Za-z0-9_-]+\/){1,8}$/.test(prefix)) invalid();
  return prefix;
}
/** Includes tar headers/padding; archive size is independently enforced in the host. */
export function checkpointArchiveLimit(policy: CheckpointPolicy) {
  return policy.maxBytes + policy.maxFiles * 4096 + 10240;
}
