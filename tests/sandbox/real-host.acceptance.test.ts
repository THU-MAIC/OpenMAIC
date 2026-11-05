/** Opt in explicitly: RUN_SANDBOX_HOST_ACCEPTANCE=1 pnpm exec vitest run this-file.
 * Real PG + Aliyun, two host-verified principals. Does not simulate the platform's future login UI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Sandbox } from 'e2b';
import { sandboxConfig } from '@/lib/server/sandbox/config';
import { mkdir, writeFile } from 'node:fs/promises';
vi.mock('server-only', () => ({}));
import { SandboxService } from '@/lib/server/sandbox/service';
import { E2BCompatibleSandboxProvider } from '@/lib/server/sandbox/providers/e2b-compatible';
import { sessionSandboxTools } from '@/lib/server/sandbox/agent-tools';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
const enabled = process.env.RUN_SANDBOX_HOST_ACCEPTANCE === '1';
const scope = 'acceptance-host-' + Date.now();
const principal = (ownerId: string): OwnerPrincipal => ({
  ownerId,
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
});
const a = principal(scope + '-a'),
  b = principal(scope + '-b');
let sa: SandboxService, sb: SandboxService, envId: string, sessionId: string;
const owned: string[] = [];
const allocated: { id: string; operationId: string }[] = [];
const evidence: {
  scope: string;
  commit: string;
  checks: string[];
  cleanup: unknown[];
  error?: string;
} = {
  scope,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checks: [],
  cleanup: [],
};
describe.skipIf(!enabled)('real host authorization, grants and recovery', () => {
  beforeAll(async () => {
    process.loadEnvFile('.env.local');
    sa = await SandboxService.forOwner(a);
    sb = await SandboxService.forOwner(b);
    envId = randomUUID();
    owned.push(envId);
    const env = await sa.create(envId, scope);
    expect(env.state).toBe('running');
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (sa)
      for (const id of owned) {
        try {
          await sa.destroy(id);
          evidence.cleanup.push({ id, released: true });
        } catch {
          evidence.cleanup.push({ id, released: false });
        }
      }
    // Fault injection knows the exact allocated resource even if provider list visibility lags.
    const { sandboxConfig } = await import('@/lib/server/sandbox/config');
    const provider = new E2BCompatibleSandboxProvider(sandboxConfig()!);
    for (const resource of allocated) await provider.destroy(resource.id, resource.operationId);
    await mkdir('test-results/sandbox', { recursive: true });
    await writeFile(`test-results/sandbox/${scope}.json`, JSON.stringify(evidence, null, 2) + '\n');
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL!);
    await pool.end();
  }, 60000);
  it('separates verified owners and refuses anonymous, unverified and unprivileged principals', async () => {
    await sa.writeText(envId, 'owned.txt', 'OWNER_A_ONLY');
    await expect(sb.get(envId)).rejects.toMatchObject({ status: 404 });
    await expect(sb.readText(envId, 'owned.txt')).rejects.toMatchObject({ status: 404 });
    await expect(
      sb.startCommand(envId, { requestId: randomUUID(), command: 'echo forbidden' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(sb.preview(envId, 3000)).rejects.toMatchObject({ status: 404 });
    for (const p of [
      { ...b, kind: 'anonymous' as const },
      { ...b, assurance: 'unverified-legacy' as const },
      { ...b, roles: new Set<string>() },
    ])
      await expect(SandboxService.forOwner(p)).rejects.toMatchObject({ status: 403 });
    expect(await sb.list()).toEqual([]);
    evidence.checks.push('verified owner isolation; anonymous/unverified/missing-role denied');
  }, 60000);
  it('serializes concurrent saves and keeps checkpoints owner-scoped', async () => {
    const results = await Promise.allSettled([
      sa.saveWorkspace(envId, 0),
      sa.saveWorkspace(envId, 0),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await sa.checkpoint(envId))?.revision).toBe(1);
    expect(await sb.savedProjects()).toEqual([]);
    await expect(sb.deleteSavedProject(scope, 1)).rejects.toMatchObject({ status: 409 });
    evidence.checks.push(
      'concurrent checkpoint write has one winner; foreign owner cannot read/delete checkpoint',
    );
  }, 60000);
  it('binds tools to an existing owned session and enforces replaced/revoked/expired grants', async () => {
    const sessions = await getAgentSessionStore();
    const session = await sessions.createSession({
      ownerId: a.ownerId,
      prompt: 'Sandbox acceptance fixture. Do not run.',
      status: 'succeeded',
      origin: 'http://localhost:3200',
    });
    sessionId = session.id;
    await expect(sb.grantSession(envId, sessionId, true, true)).rejects.toMatchObject({
      status: 403,
    });
    expect(await sessionSandboxTools(sessionId, a.ownerId)).toEqual([]);
    await sa.grantSession(envId, sessionId, false, false);
    const readOnly = await sessionSandboxTools(sessionId, a.ownerId);
    expect(readOnly.map((x) => x.name)).toEqual(['sandbox_read_file', 'sandbox_list_files']);
    await sa.grantSession(envId, sessionId, true, true);
    const stale = await readOnly[0].execute('test-stale', { path: 'owned.txt' } as never);
    expect(stale).toMatchObject({ isError: true });
    const tools = await sessionSandboxTools(sessionId, a.ownerId);
    const write = tools.find((x) => x.name === 'sandbox_write_file')!;
    const written = await write.execute('test-write', {
      path: 'grant.txt',
      text: 'GRANT_OK',
    } as never);
    expect((written as { isError?: boolean }).isError).not.toBe(true);
    expect(await sa.readText(envId, 'grant.txt')).toBe('GRANT_OK');
    await sa.revokeSession(sessionId);
    expect(await sessionSandboxTools(sessionId, a.ownerId)).toEqual([]);
    expect(
      await write.execute('test-revoked', { path: 'forbidden', text: 'bad' } as never),
    ).toMatchObject({ isError: true });
    await sa.grantSession(envId, sessionId, true, true);
    const expiryTools = await sessionSandboxTools(sessionId, a.ownerId);
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL!);
    await pool.query(
      "update sandbox_session_grants set expires_at=now()-interval '1 second' where session_id=$1 and owner_id=$2",
      [sessionId, a.ownerId],
    );
    expect(await expiryTools[0].execute('expired', { path: 'owned.txt' } as never)).toMatchObject({
      isError: true,
    });
    evidence.checks.push(
      'read-only/write scope; replaced, revoked, expired grants refused at execution',
    );
  }, 60000);
  it('keeps a real allocation blocked after initialization failure and recovers without another create', async () => {
    const failedId = randomUUID();
    owned.push(failedId);
    // Reuse the existing environment so the per-owner trial limit stays one.
    await sa.saveWorkspace(envId, 1, true);
    const init = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'initializeWorkspace')
      .mockRejectedValueOnce(new Error('Injected initialization failure'));
    const create = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'create');
    try {
      await expect(sa.create(failedId, scope)).rejects.toThrow('Injected initialization failure');
      expect(await sa.get(failedId)).toMatchObject({ state: 'running', workspaceReady: false });
      await expect(sa.readText(failedId, 'owned.txt')).rejects.toMatchObject({ status: 409 });
      expect((await sa.reconcile(failedId)).workspaceReady).toBe(true);
      expect(await sa.readText(failedId, 'owned.txt')).toBe('OWNER_A_ONLY');
      expect(create).toHaveBeenCalledTimes(1);
      evidence.checks.push(
        'real allocation initialization failure stays blocked; reconcile initializes and restores without reallocation',
      );
      envId = failedId;
    } finally {
      init.mockRestore();
      create.mockRestore();
    }
  }, 90000);
  it('reconciles a real allocation after a deliberately lost create response, restores without duplicating', async () => {
    await sa.saveWorkspace(envId, 2, true);
    const original = E2BCompatibleSandboxProvider.prototype.create;
    const lost = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'create')
      .mockImplementationOnce(async function (this: E2BCompatibleSandboxProvider, ...args) {
        const resource = await original.apply(this, args);
        allocated.push({ id: resource.id, operationId: args[0] });
        throw new Error('Injected lost allocation response');
      });
    envId = randomUUID();
    owned.push(envId);
    expect((await sa.create(envId, scope)).state).toBe('unknown');
    expect((await sa.create(envId, scope)).state).toBe('unknown');
    expect(lost).toHaveBeenCalledTimes(1);
    lost.mockRestore();
    let found = await sa.reconcile(envId);
    const started = Date.now();
    while (found.state === 'unknown' && Date.now() - started < 30000) {
      await new Promise((r) => setTimeout(r, 1000));
      found = await sa.reconcile(envId);
    }
    evidence.checks.push('discovery wait ms: ' + (Date.now() - started));
    expect(found.state).toBe('running');
    expect(found.workspaceReady).toBe(true);
    await sa.restoreWorkspace(envId);
    expect(await sa.readText(envId, 'owned.txt')).toBe('OWNER_A_ONLY');
    evidence.checks.push(
      'real create response loss reconciled by metadata; repeated create does not allocate again; restore gate protects files',
    );
  }, 90000);
  it('does not extend a lease on file access and restores the last checkpoint after real TTL expiry', async () => {
    const config = sandboxConfig();
    const options = {
      apiKey: config.apiKey,
      domain: config.domain,
      apiUrl: config.apiUrl,
    };
    const resource = allocated.find((x) => x.operationId === envId)!;
    await sa.saveWorkspace(envId, 3);
    await Sandbox.setTimeout(resource.id, 60000, options);
    const before = await Sandbox.getInfo(resource.id, options);
    expect(await sa.readText(envId, 'owned.txt')).toBe('OWNER_A_ONLY');
    const after = await Sandbox.getInfo(resource.id, options);
    expect(after.endAt.getTime()).toBeLessThanOrEqual(before.endAt.getTime() + 1000);
    await new Promise((r) => setTimeout(r, 65000));
    await expect(sa.readText(envId, 'owned.txt')).rejects.toMatchObject({ status: 409 });
    const expiryWait = Date.now();
    let expired = await sa.reconcile(envId);
    while (expired.state !== 'destroyed' && Date.now() - expiryWait < 60000) {
      await new Promise((r) => setTimeout(r, 5000));
      expired = await sa.reconcile(envId);
    }
    evidence.checks.push(
      'provider expiry status visibility lag beyond initial 65s wait: ' +
        (Date.now() - expiryWait) +
        ' ms',
    );
    expect(expired.state).toBe('destroyed');
    envId = randomUUID();
    owned.push(envId);
    expect((await sa.create(envId, scope)).state).toBe('running');
    expect(await sa.readText(envId, 'owned.txt')).toBe('OWNER_A_ONLY');
    evidence.checks.push(
      'real 60s provider TTL expired; file access did not extend lease; last checkpoint restored into new environment',
    );
  }, 160000);
});
