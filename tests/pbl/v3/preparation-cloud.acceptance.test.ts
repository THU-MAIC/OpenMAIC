/** Explicit paid opt-in. Real PG + configured cloud + checkpoint storage; no model or browser simulation. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Sandbox } from 'e2b';
vi.mock('server-only', () => ({}));
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { commandStudy, learningView } from '@/lib/server/pbl-v3/runtime';
import { maintainStudy } from '@/lib/server/pbl-v3/lifecycle';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { resolvedSandboxConfig } from '@/lib/server/sandbox/settings';
import { E2BCompatibleSandboxProvider } from '@/lib/server/sandbox/providers/e2b-compatible';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
  type WorkspaceMutation,
} from '@/lib/server/sandbox/managed-workspace';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

const enabled = process.env.RUN_PBL_PREPARATION_CLOUD === '1';
const scope = 'preparation-cloud-' + randomUUID();
const principal: OwnerPrincipal = {
  ownerId: scope,
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
};
const owned = new Set<string>();
const evidence: Record<string, unknown> = { scope, checks: [], cleanup: [] };
let store: LearningStore, service: SandboxService, provider: E2BCompatibleSandboxProvider;
let options: {
  apiKey: string;
  validateApiKey: false;
  apiUrl?: string;
  domain?: string;
  requestTimeoutMs: number;
};
const fixtureProject = installedProject({ id: 'greeting-python', version: '1.0.0' });
async function fixture() {
  const row = await store.create(
    {
      ownerId: principal.ownerId,
      stageId: randomUUID(),
      sceneId: 'scene',
      projectId: fixtureProject.ref.id,
      version: fixtureProject.ref.version,
    },
    startOrchestration(fixtureProject.definition),
  );
  owned.add(row.id);
  return row.id;
}
async function send(id: string, type: 'prepare' | 'checkpoint') {
  const row = await store.get(id, principal.ownerId);
  return commandStudy(principal, id, { id: randomUUID(), revision: row.revision, type });
}
async function scoped<T>(
  study: string,
  environment: string,
  operations: WorkspaceMutation[],
  action: () => Promise<T>,
) {
  return withLearningWorkspaceAccess(
    {
      ownerId: principal.ownerId,
      workspaceId: learningWorkspaceId(study),
      environmentIds: () => [environment],
      operations,
    },
    action,
  );
}
async function pending(id: string) {
  const row = await store.get(id, principal.ownerId);
  row.environment_recovery = { requestId: id };
  await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
  await scoped(id, id, ['create', 'restore'], () => service.create(id, learningWorkspaceId(id)));
  return (await (await SandboxStore.open()).list(principal.ownerId)).find((row) => row.id === id)!;
}
async function release(studies: string[]) {
  const workspaces = new Set(studies.map(learningWorkspaceId));
  const rows = (await (await SandboxStore.open()).list(principal.ownerId)).filter((row) =>
    workspaces.has(row.workspace_id),
  );
  for (const row of rows) {
    await scoped(row.workspace_id.slice(4), row.id, ['destroy'], () => service.destroy(row.id));
    if (row.resource_id) expect(await provider.inspect(row.resource_id, row.id)).toBeNull();
  }
}

beforeAll(async () => {
  if (!enabled) return;
  // The harness supplies a dedicated DB. Refuse accidental use of the human-trial DB.
  expect(new URL(process.env.DATABASE_URL!).pathname).toContain('prepare_fix');
  console.info('Cloud preflight: resolving deployment configuration');
  const config = await resolvedSandboxConfig();
  console.info('Cloud preflight: deployment resolved');
  options = {
    apiKey: config.apiKey,
    validateApiKey: false,
    apiUrl: config.apiUrl,
    domain: config.domain,
    requestTimeoutMs: 30_000,
  };
  const pager = Sandbox.list({ ...options, query: { state: ['running', 'paused'] } });
  const active = [];
  while (pager.hasNext) active.push(...(await pager.nextItems()));
  if (active.length > 3)
    throw new Error(
      'Insufficient free author-test capacity; no existing resources will be changed.',
    );
  console.info('Cloud preflight: inventory checked, active resources', active.length);
  evidence.initialCloudResources = active.length;
  console.info('Cloud preflight: opening isolated persistence');
  store = await LearningStore.open();
  console.info('Cloud preflight: persistence ready');
  service = await SandboxService.forOwner(principal);
  provider = new E2BCompatibleSandboxProvider(config);
}, 120_000);
afterAll(async () => {
  if (!enabled || !service) return;
  vi.restoreAllMocks();
  try {
    await release([...owned]);
    evidence.cleanup = (await (await SandboxStore.open()).list(principal.ownerId)).map((row) => ({
      operationId: row.id,
      resourceId: row.resource_id,
      state: row.state,
    }));
  } finally {
    await mkdir('test-results/pbl', { recursive: true });
    await writeFile(`test-results/pbl/${scope}.json`, JSON.stringify(evidence, null, 2));
    await (await getServerPersistenceProvider(process.env.DATABASE_URL!)).pool.end();
  }
}, 60_000);

it.skipIf(!enabled)(
  'prepares two real projects independently while maintenance observes a paused pending preparation',
  async () => {
    const first = await fixture(),
      second = await fixture();
    const allocation = await pending(first);
    expect(await provider.inspect(allocation.resource_id!, first)).not.toBeNull();
    await Sandbox.setTimeout(allocation.resource_id!, 30_000, options);
    let enter!: () => void, releaseList!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const originalList = SandboxService.prototype.listFiles;
    let blocked = false;
    const listing = vi
      .spyOn(SandboxService.prototype, 'listFiles')
      .mockImplementation(async function (this: SandboxService, ...args) {
        if (args[0] === first && !blocked) {
          blocked = true;
          enter();
          await gate;
        }
        return originalList.apply(this, args);
      });
    const renew = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'renew');
    const preparation = send(first, 'prepare').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const safety = setTimeout(() => releaseList(), 60_000);
    try {
      await entered;
      const before = renew.mock.calls.length;
      await expect(
        maintainStudy(new LearningStore(store.pool), first, principal.ownerId),
      ).rejects.toMatchObject({ reason: 'STUDY_BUSY' });
      expect(renew.mock.calls.length).toBe(before);
      await send(second, 'prepare');
      const secondView = await learningView(principal, second);
      expect(secondView.environment?.ready).toBe(true);
      releaseList();
      expect(await preparation).not.toHaveProperty('error');
      const firstView = await learningView(principal, first);
      expect(firstView.environment?.ready).toBe(true);
      expect(firstView.environmentId).toBe(first);
      expect(firstView.environmentId).not.toBe(secondView.environmentId);
      const info = await Sandbox.getInfo(allocation.resource_id!, options);
      expect(info.endAt.getTime() - Date.now()).toBeGreaterThan(60_000);
      (evidence.checks as unknown[]).push({
        kind: 'two-independent-preparations-and-deferred-maintenance',
        first: firstView.environmentId,
        second: secondView.environmentId,
        renewedPendingBeforeFiles: true,
      });
    } finally {
      clearTimeout(safety);
      releaseList();
      await preparation;
      listing.mockRestore();
      renew.mockRestore();
      await release([first, second]);
    }
  },
  180_000,
);

it.skipIf(!enabled)(
  'recovers a confirmed missing pending cloud allocation in one preparation request',
  async () => {
    const id = await fixture(),
      allocation = await pending(id);
    expect(await provider.inspect(allocation.resource_id!, id)).not.toBeNull();
    // Only this author's fixture is removed, modelling the same confirmed absence as TTL expiry.
    await Sandbox.kill(allocation.resource_id!, options);
    expect(await provider.inspect(allocation.resource_id!, id)).toBeNull();
    try {
      await send(id, 'prepare');
      const view = await learningView(principal, id);
      expect(view.environment?.ready).toBe(true);
      expect(view.environmentId).not.toBe(id);
      (evidence.checks as unknown[]).push({
        kind: 'confirmed-missing-pending-allocation',
        studyId: id,
        recoveredEnvironmentId: view.environmentId,
        onePreparationRequest: true,
      });
    } finally {
      await release([id]);
    }
  },
  120_000,
);

it.skipIf(!enabled)(
  'restores a real durable checkpoint without replacing it with starter files',
  async () => {
    const id = await fixture();
    try {
      await send(id, 'prepare');
      const starting = await store.get(id, principal.ownerId);
      const before = starting.environment_id!;
      await scoped(id, before, ['write'], () =>
        service.writeText(before, 'PLAN.md', 'AUTHOR_CHECKPOINT_PRESERVED\n'),
      );
      await send(id, 'checkpoint');
      const saved = await service.checkpoint(before);
      expect(saved?.revision).toBeGreaterThan(0);
      await scoped(id, before, ['destroy'], () => service.destroy(before));
      await send(id, 'prepare');
      const after = await store.get(id, principal.ownerId);
      expect(after.environment_id).not.toBe(before);
      expect(await service.readText(after.environment_id!, 'PLAN.md')).toBe(
        'AUTHOR_CHECKPOINT_PRESERVED\n',
      );
      expect(after.state.position).toEqual(starting.state.position);
      (evidence.checks as unknown[]).push({
        kind: 'durable-checkpoint-restore',
        studyId: id,
        checkpointRevision: saved?.revision,
        restoredEnvironmentId: after.environment_id,
        savedPlanPreserved: true,
      });
    } finally {
      await release([id]);
    }
  },
  180_000,
);
