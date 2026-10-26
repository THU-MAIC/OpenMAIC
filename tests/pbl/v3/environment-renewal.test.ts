import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { touchEnvironment } from '@/lib/server/pbl-v3/environment';
import type { LearningStore, Study } from '@/lib/server/pbl-v3/store';
import type { SandboxService } from '@/lib/server/sandbox/service';
import type { SandboxEnvironment } from '@/lib/sandbox/types';
import { sandboxConflict } from '@/lib/sandbox/errors';

vi.mock('server-only', () => ({}));
const clock = vi.hoisted(() => ({ now: 0, onDelay: undefined as (() => void) | undefined }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (ms: number) => {
    clock.now += ms;
    clock.onDelay?.();
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  clock.now = 1_700_000_000_000;
  clock.onDelay = undefined;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  // Only the keepalive boundary is stubbed; teaching tools and real locks are
  // exercised together in runtime.pg.test.ts.
  const row = {
    id: 'study',
    owner_id: 'learner',
    environment_id: 'environment',
    environment_checked_at: null,
  } as Study;
  const env: SandboxEnvironment = {
    id: 'environment',
    workspaceId: 'learning',
    profile: 'code',
    state: 'running',
    workspaceReady: true,
    createdAt: new Date(clock.now).toISOString(),
    updatedAt: new Date(clock.now).toISOString(),
  };
  const getStudy = vi.fn(async () => row);
  const query = vi.fn(async () => ({ rows: [{ id: row.id }] }));
  const getEnvironment = vi.fn(async () => env);
  const reconcile = vi.fn(async () => env);
  const renew = vi.fn(async () => ({ renewed: true, lifetimeMs: 60_000 }));
  const store = { get: getStudy, pool: { query } } as unknown as LearningStore;
  const service = { get: getEnvironment, reconcile, renew } as unknown as SandboxService;
  return { row, env, getStudy, query, getEnvironment, reconcile, renew, store, service };
}

it('does not contact the provider when the study has no environment', async () => {
  const f = fixture();
  f.row.environment_id = null;
  expect(await touchEnvironment(f.store, f.row, f.service)).toBeNull();
  expect(f.getEnvironment).not.toHaveBeenCalled();
});

it('throttles using durable check time even when the caller has an old snapshot', async () => {
  const f = fixture();
  const stale = { ...f.row };
  f.row.environment_checked_at = new Date(clock.now);
  expect(await touchEnvironment(f.store, stale, f.service)).toBe(f.env);
  expect(f.renew).not.toHaveBeenCalled();
  expect(f.reconcile).not.toHaveBeenCalled();
});

it('records a successful renewal against the same owner and environment', async () => {
  const f = fixture();
  expect(await touchEnvironment(f.store, f.row, f.service)).toBe(f.env);
  expect(f.renew).toHaveBeenCalledExactlyOnceWith(f.env.id);
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('RETURNING id'), [
    f.row.id,
    f.row.owner_id,
    f.env.id,
  ]);
});

it('reconciles a passive view without renewing or advancing the successful renewal time', async () => {
  const f = fixture();
  expect(await touchEnvironment(f.store, f.row, f.service, false)).toBe(f.env);
  expect(f.reconcile).toHaveBeenCalledOnce();
  expect(f.renew).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});

it("reuses another request's successful check after an environment lock conflict", async () => {
  const f = fixture();
  f.renew.mockRejectedValueOnce(sandboxConflict('busy', 'ENVIRONMENT_BUSY'));
  clock.onDelay = () => {
    f.row.environment_checked_at = new Date(clock.now);
  };
  expect(await touchEnvironment(f.store, { ...f.row }, f.service)).toBe(f.env);
  expect(f.renew).toHaveBeenCalledTimes(1);
  expect(f.query).not.toHaveBeenCalled();
});

it('can renew after a workspace mutation releases its lock without repeated provider inspection', async () => {
  const f = fixture();
  f.renew.mockRejectedValueOnce(sandboxConflict('busy', 'ENVIRONMENT_BUSY'));
  expect(await touchEnvironment(f.store, f.row, f.service)).toBe(f.env);
  expect(f.renew).toHaveBeenCalledTimes(2);
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(f.query).toHaveBeenCalledTimes(1);
});

it('bounds contention retries to five seconds and never records an unsuccessful check', async () => {
  const f = fixture();
  const error = sandboxConflict('busy', 'ENVIRONMENT_BUSY');
  f.renew.mockRejectedValue(error);
  const started = clock.now;
  await expect(touchEnvironment(f.store, f.row, f.service)).rejects.toBe(error);
  expect(clock.now - started).toBe(5_000);
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(f.query).not.toHaveBeenCalled();
});

it.each([new Error('Provider unavailable'), sandboxConflict('Not running')])(
  'propagates non-contention renewal errors without retrying: %s',
  async (error) => {
    const f = fixture();
    f.renew.mockRejectedValue(error);
    await expect(touchEnvironment(f.store, f.row, f.service)).rejects.toBe(error);
    expect(delay).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  },
);

it('rejects a replaced environment before renewing an old snapshot', async () => {
  const f = fixture();
  const stale = { ...f.row };
  f.row.environment_id = 'replacement';
  await expect(touchEnvironment(f.store, stale, f.service)).rejects.toThrow('environment changed');
  expect(f.renew).not.toHaveBeenCalled();
});

it('rechecks environment identity after contention rather than following a replacement', async () => {
  const f = fixture();
  const stale = { ...f.row };
  f.renew.mockRejectedValueOnce(sandboxConflict('busy', 'ENVIRONMENT_BUSY'));
  clock.onDelay = () => {
    f.row.environment_id = 'replacement';
  };
  await expect(touchEnvironment(f.store, stale, f.service)).rejects.toThrow('environment changed');
  expect(f.renew).toHaveBeenCalledTimes(1);
  expect(f.query).not.toHaveBeenCalled();
});

it('rejects replacement during a successful provider call instead of recording a stale check', async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce({ rows: [] });
  await expect(touchEnvironment(f.store, f.row, f.service)).rejects.toThrow('environment changed');
});

it('returns an unavailable environment without renewing or recording readiness', async () => {
  const f = fixture();
  f.env.state = 'destroyed';
  f.env.workspaceReady = false;
  expect(await touchEnvironment(f.store, f.row, f.service)).toBe(f.env);
  expect(f.renew).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
