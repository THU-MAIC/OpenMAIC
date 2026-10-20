import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { isProjectSource, projectFiles } from '@/lib/server/pbl-v3/workspace-files';
import { filesFingerprint, readFiles } from '@/lib/server/pbl-v3/runtime';
import type { SandboxService } from '@/lib/server/sandbox/service';
import type { Study } from '@/lib/server/pbl-v3/store';
import { WORKSPACE_EXCLUDES } from '@/lib/server/sandbox/workspace-archive';
const project = {
  ...installedProject({ id: 'greeting-python', version: '1.0.0' }),
  sourceRoots: undefined,
};
const expanded = { ...project, sourceRoots: ['src'] };
const row = { environment_id: 'environment' } as Study;
describe('shared project source scope', () => {
  it('keeps closed packages closed and matches directory boundaries, excluding generated content', () => {
    expect(isProjectSource(project, 'greeting.py')).toBe(true);
    expect(isProjectSource(project, 42)).toBe(false);
    expect(isProjectSource(project, null)).toBe(false);
    expect(isProjectSource(project, 'src/Extra.java')).toBe(false);
    expect(isProjectSource(expanded, 'src/nested/Extra.java')).toBe(true);
    expect(isProjectSource(expanded, 'src/next/page.ts')).toBe(true);
    expect(isProjectSource(expanded, 'src/venv_helpers.py')).toBe(true);
    for (const path of [
      'src2/Extra.java',
      '../PLAN.md',
      '/PLAN.md',
      'src/../PLAN.md',
      'src/./x.py',
      'src//x.py',
      'src\\x.py',
      'src/a\0.py',
      'src/node_modules/x.js',
      'src/target/X.java',
      'src/.git/x.py',
      ...WORKSPACE_EXCLUDES.map((name) => `src/nested/${name}/x.py`),
    ])
      expect(isProjectSource(expanded, path), path).toBe(false);
    expect(
      isProjectSource({ ...expanded, files: { 'src/.venv/main.py': '' } }, 'src/.venv/main.py'),
    ).toBe(false);
  });
  it('uses the same discovered files for evidence and detects added/removed source files', async () => {
    const files: Record<string, string> = {
      'PLAN.md': 'plan',
      'greeting.py': 'code',
      'src/App.java': 'class App {}',
      'src/target/Cached.java': 'ignored',
    };
    const sandbox = {
      assertWorkspaceIdle: vi.fn(),
      listFiles: async () => Object.keys(files).map((path) => ({ path, bytes: 1 })),
      readText: async (_id: string, path: string) => files[path],
    } as unknown as SandboxService;
    const first = await readFiles(sandbox, row, expanded);
    expect(Object.keys(first)).toEqual(['PLAN.md', 'greeting.py', 'src/App.java']);
    delete files['src/App.java'];
    expect(filesFingerprint(await readFiles(sandbox, row, expanded))).not.toBe(
      filesFingerprint(first),
    );
    expect(await projectFiles(sandbox, 'environment', project)).toEqual(['PLAN.md', 'greeting.py']);
  });
  it('bounds file count and total text and refuses snapshots while a writer is active', async () => {
    const sandbox = {
      assertWorkspaceIdle: vi.fn(),
      listFiles: vi
        .fn()
        .mockResolvedValue(
          Array.from({ length: 257 }, (_, i) => ({ path: `src/${i}.py`, bytes: 1 })),
        ),
      readText: vi.fn().mockResolvedValue('a'.repeat(600000)),
    };
    await expect(
      projectFiles(sandbox as unknown as SandboxService, 'environment', expanded),
    ).rejects.toThrow('256');
    await expect(readFiles(sandbox as unknown as SandboxService, row, project)).rejects.toThrow(
      '1 MiB',
    );
    sandbox.assertWorkspaceIdle.mockRejectedValueOnce(new Error('running writer'));
    await expect(readFiles(sandbox as unknown as SandboxService, row, project)).rejects.toThrow(
      'running writer',
    );
  });
});
