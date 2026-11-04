/** Paid cloud opt-in. Uses the configured E2B-compatible endpoint; never runs in normal CI. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { Sandbox } from 'e2b';
vi.mock('server-only', () => ({}));
import { sandboxConfig } from '@/lib/server/sandbox/config';
import { E2BCompatibleSandboxProvider } from '@/lib/server/sandbox/providers/e2b-compatible';

it.skipIf(process.env.RUN_SANDBOX_COMPAT_ACCEPTANCE !== '1')(
  'uses the same adapter for create, files, commands, protected native preview and deletion',
  async () => {
    const config = sandboxConfig();
    expect(config.lifetimeMs).toBeLessThanOrEqual(300_000);
    const options = { apiKey: config.apiKey, apiUrl: config.apiUrl, domain: config.domain };
    async function inventory() {
      const p = Sandbox.list(options);
      const rows = [];
      while (p.hasNext) rows.push(...(await p.nextItems()));
      return rows;
    }
    const initial = await inventory();
    expect(initial.length).toBeLessThan(5);
    const provider = new E2BCompatibleSandboxProvider(config);
    const operationId = randomUUID();
    const evidence = {
      startedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      endpoint: config.apiUrl,
      template: config.template,
      initialCloudCount: initial.length,
      checks: [] as string[],
      cleanup: [] as string[],
      error: undefined as string | undefined,
    };
    try {
      const resource = await provider.create(operationId, 'code');
      evidence.checks.push('create ' + resource.id);
      await provider.initializeWorkspace(resource.id, operationId);
      await provider.writeText(resource.id, operationId, 'main.py', 'print("COMPAT_OK")\n');
      expect(await provider.readText(resource.id, operationId, 'main.py')).toContain('COMPAT_OK');
      const commandId = randomUUID();
      await provider.startCommand(resource.id, operationId, {
        id: commandId,
        command: 'python3 main.py',
        cwd: '/home/user/project',
        timeoutMs: 15000,
      });
      let result = await provider.readCommand(resource.id, operationId, commandId);
      const deadline = Date.now() + 30000;
      while (['unknown', 'starting', 'running'].includes(result.state) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        result = await provider.readCommand(resource.id, operationId, commandId);
      }
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('COMPAT_OK');
      evidence.checks.push('file read/write and supervised Python execution');
      await provider.writeText(
        resource.id,
        operationId,
        'index.html',
        '<h1>COMPAT_PREVIEW_OK</h1>',
      );
      await provider.startCommand(resource.id, operationId, {
        id: randomUUID(),
        command: 'python3 -m http.server 3000',
        cwd: '/home/user/project',
        timeoutMs: 60000,
      });
      const target = await provider.nativePreview(resource.id, operationId, 3000);
      let response = await fetch(target.url, {
        headers: target.headers,
        signal: AbortSignal.timeout(15000),
      });
      for (let i = 0; !response.ok && i < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        response = await fetch(target.url, {
          headers: target.headers,
          signal: AbortSignal.timeout(15000),
        });
      }
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('COMPAT_PREVIEW_OK');
      const anonymous = await fetch(target.url, { signal: AbortSignal.timeout(15000) });
      expect(anonymous.ok).toBe(false);
      evidence.checks.push('protected native HTTP succeeds; anonymous access refused');
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : 'Unknown failure';
      throw error;
    } finally {
      try {
        // Metadata discovery also covers a create whose response was lost.
        for (const resource of await provider.find(operationId)) {
          await provider.destroy(resource.id, operationId);
          evidence.cleanup.push(resource.id);
        }
        const remaining = (await inventory()).filter(
          (r) => r.metadata.openmaic_operation === operationId,
        );
        expect(remaining).toHaveLength(0);
        evidence.checks.push('owned cloud inventory empty after kill');
      } finally {
        await mkdir('test-results/sandbox', { recursive: true });
        await writeFile(
          `test-results/sandbox/compat-${Date.now()}.json`,
          JSON.stringify(evidence, null, 2),
        );
      }
    }
  },
  180000,
);
