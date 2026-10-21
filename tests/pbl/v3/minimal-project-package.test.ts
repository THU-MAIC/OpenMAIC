import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PBLProjectPackage } from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { validateProjectPackage, packagedStageSkill } from '@/lib/server/pbl-v3/project-package';
import {
  readClassroomProjects,
  validateClassroomPackageCompatibility,
} from '@/lib/pbl/v3/package-client';
import { evaluationFor, evaluationCommand, evaluationPassed } from '@/lib/server/pbl-v3/evaluation';

const run = promisify(execFile);
describe('independently authored minimal course archive', () => {
  let root = '',
    bundle: PBLProjectPackage,
    manifest: ClassroomManifest;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pbl-minimal-example-'));
    const output = join(root, 'course.maic.zip');
    await run(process.execPath, [resolve('scripts/build-pbl-example.mjs'), output]);
    const zip = await JSZip.loadAsync(await readFile(output));
    manifest = JSON.parse(await zip.file('manifest.json')!.async('text'));
    [bundle] = await readClassroomProjects(zip, manifest.pblProjects!);
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('loads every authored resource and binds its own teaching, starter and evaluation', async () => {
    validateClassroomPackageCompatibility(manifest);
    const { project } = validateProjectPackage(bundle);
    expect(() => installedProject(project.ref)).toThrow();
    expect(manifest.scenes).toHaveLength(1);
    expect(manifest.scenes[0].content).toEqual({
      type: 'pbl',
      projectV3: { id: 'future-self-lite', version: '1.0.0', packageId: bundle.entry.checksum },
    });
    expect(Object.keys(bundle.files).sort()).toEqual([
      'docs/brief.md',
      'project.json',
      'skeleton/PLAN.md',
      'skeleton/src/main.py',
      'skills/A-implement.md',
      'skills/A-intro.md',
      'skills/SKILL.md',
      'tests/check.py',
      'tests/message.json',
    ]);
    for (const [name, text] of Object.entries(bundle.files))
      expect(text).toBe(await readFile(resolve('examples/pbl/future-self-lite', name), 'utf8'));
    expect(Object.keys(project.files).sort()).toEqual(['PLAN.md', 'src/main.py']);
    const stage = project.definition.milestones[0].stages[0];
    const skill = packagedStageSkill(project, stage, 'message:0', 'coder');
    expect(skill.content['A-implement.md']).toContain('src/main.py');
    expect(skill.content['A-implement.md']).toContain(bundle.files['skills/SKILL.md']);
    expect(skill.documents).toEqual([
      { path: 'docs/brief.md', text: bundle.files['docs/brief.md'] },
    ]);
    expect(evaluationFor(project, 'message').resources?.['tests/check.py']).toBe(
      bundle.files['tests/check.py'],
    );
  });

  it.runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')(
    'fails the starter and passes an implementation using the real private test runner',
    async () => {
      const { project } = validateProjectPackage(bundle);
      const workspace = join(root, 'workspace');
      for (const [name, text] of Object.entries(project.files)) {
        await mkdir(dirname(join(workspace, name)), { recursive: true });
        await writeFile(join(workspace, name), text);
      }
      const spec = evaluationFor(project, 'message');
      await run('/bin/sh', ['-c', project.buildCommand!], { cwd: workspace });
      const starter = await run('/bin/sh', ['-c', evaluationCommand(spec, 'starter')], {
        cwd: workspace,
      });
      expect(evaluationPassed(spec, 'starter', starter.stdout)).toBe(false);
      await writeFile(
        join(workspace, 'src/main.py'),
        'def future_message(name):\n    return f"给未来的{name}：继续保持好奇心。"\n',
      );
      await run('/bin/sh', ['-c', project.buildCommand!], { cwd: workspace });
      const solution = await run('/bin/sh', ['-c', evaluationCommand(spec, 'solution')], {
        cwd: workspace,
      });
      expect(evaluationPassed(spec, 'solution', solution.stdout)).toBe(true);
      expect(solution.stdout).toContain('1 / 1 checks passed');
      // Verification edits only the temporary workspace; the exported starter stays unfinished.
      expect(project.files['src/main.py']).toContain('return ""');
    },
  );
});
