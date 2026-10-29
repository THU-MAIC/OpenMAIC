import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  packageBuiltin,
  validateProjectPackage,
  indexProjectFiles,
  packagedStageSkill,
  canonicalJson,
} from '@/lib/server/pbl-v3/project-package';
import { evaluationFor, evaluationCommand, evaluationPassed } from '@/lib/server/pbl-v3/evaluation';
import {
  readClassroomProjects,
  validateClassroomPackageCompatibility,
  attachClassroomProjects,
  installClassroomProjects,
  DECISION_RESPONSE_CAPABILITY,
} from '@/lib/pbl/v3/package-client';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { bindPackageReferences } from '@/lib/server/pbl-v3/project-resolver';
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import { enumerateAssetManifest, validatePBLContent, isPBLV3Reference } from '@openmaic/dsl';

const source = (id = 'greeting-python-lab') =>
  installedProject({ id, version: id === 'greeting-python' ? '1.0.0' : '1.1.0' });
function revised(change: (files: Record<string, string>) => void) {
  const original = packageBuiltin(source());
  const files = { ...original.files };
  change(files);
  return indexProjectFiles(original.entry.id, original.entry.version, files);
}
function manifest(): ClassroomManifest {
  return {
    formatVersion: 1,
    exportedAt: '',
    appVersion: '',
    stage: { name: 'Course', createdAt: 1, updatedAt: 1 },
    agents: [],
    mediaIndex: {},
    scenes: [0, 1].map((order) => ({
      type: 'pbl',
      title: 'Project',
      order,
      content: { type: 'pbl', projectV3: source().ref },
    })),
  };
}
async function archive(bundle: ReturnType<typeof packageBuiltin>) {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(bundle.files))
    zip.file(`${bundle.entry.root}/${path}`, text);
  return JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
}
describe('self-contained PBL project packages', () => {
  it('opts into applications only through a profile-bound starter entrypoint', () => {
    const app = {
      title: 'My application',
      description: 'Add and remove items.',
      argv: ['python3', 'src/app.py', '--port', '8000'],
      port: 8000,
      healthPath: '/api/items',
    };
    const withApplication = (change: (application: typeof app) => void = () => {}) =>
      revised((files) => {
        files['skeleton/src/app.py'] = 'print("Application")\n';
        const spec = JSON.parse(files['project.json']);
        spec.runtime.application = structuredClone(app);
        change(spec.runtime.application);
        files['project.json'] = JSON.stringify(spec);
      });
    expect(validateProjectPackage(withApplication()).project.application).toEqual(app);
    for (const change of [
      (a: typeof app) => {
        a.argv = ['python3', '-c', 'print("bypass")'];
      },
      (a: typeof app) => {
        a.argv = ['sh', 'src/app.py'];
      },
      (a: typeof app) => {
        a.argv = ['python3', '../outside.py'];
      },
      (a: typeof app) => {
        a.port = 49983;
      },
      (a: typeof app) => {
        a.healthPath = 'https://elsewhere.test';
      },
    ])
      expect(() => validateProjectPackage(withApplication(change))).toThrow();
    expect(validateProjectPackage(packageBuiltin(source())).project.application).toBeUndefined();
  });
  it('rejects final application commands beyond provider bytes, including quoting and encoded paths', () => {
    for (const oversized of ['argv', 'paths']) {
      const bundle = revised((files) => {
        files['skeleton/app.py'] = 'pass\n';
        const spec = JSON.parse(files['project.json']);
        spec.runtime.application = {
          title: 'App',
          description: 'Try the saved source.',
          argv: ['python3', 'app.py', ...Array.from({ length: 30 }, () => "'".repeat(400))],
          port: 8000,
          healthPath: '/',
        };
        if (oversized === 'paths') {
          spec.runtime.application.argv = ['python3', 'app.py'];
          for (let i = 0; i < 180; i++) files[`skeleton/${'long'.repeat(50)}${i}.py`] = 'pass\n';
        }
        files['project.json'] = JSON.stringify(spec);
      });
      expect(() => validateProjectPackage(bundle)).toThrow('32 KiB command limit');
    }
  });
  it('installs only the current samples and rejects obsolete or incomplete learning structures', () => {
    for (const id of ['greeting-python-lab', 'greeting-java'])
      expect(() => installedProject({ id, version: '1.0.0' })).toThrow('not installed');
    for (const field of [
      'optional',
      'exploration',
      'missing recap',
      'wrong order',
      'release',
      'onboarding',
      'intro',
    ])
      expect(() =>
        validateProjectPackage(
          revised((files) => {
            const spec = JSON.parse(files['project.json']);
            const milestone = spec.definition.milestones[0];
            if (field === 'optional') milestone.optional = true;
            else if (field === 'exploration')
              milestone.stages[3].exploration = { introduction: 'Explore' };
            else if (field === 'missing recap') milestone.stages.pop();
            else if (field === 'wrong order') milestone.stages.reverse();
            else if (field === 'release')
              spec.definition.completionMode = 'awaiting_more_milestones';
            else if (field === 'onboarding') spec.definition.releaseOnboardings = [];
            else spec.teaching[0].stage = 'intro:-1';
            files['project.json'] = JSON.stringify(spec);
          }),
        ),
      ).toThrow();
    expect(packageBuiltin(source()).files['project.json']).not.toContain('intro:-1');
  });
  it.each(['greeting-python', 'greeting-python-lab', 'greeting-java'])(
    'round-trips %s through ZIP without catalog resolution',
    async (id) => {
      const bundle = packageBuiltin(source(id));
      const [loaded] = await readClassroomProjects(await archive(bundle), [bundle.entry]);
      const { project } = validateProjectPackage(loaded);
      expect(project.definition).toEqual({
        ...source(id).definition,
        paths: { ...source(id).definition.paths, requirements: 'docs', pedagogy: 'skills' },
      });
      expect(project.files).toEqual(source(id).files);
      expect(project.evaluations).toEqual(JSON.parse(JSON.stringify(source(id).evaluations)));
      expect(loaded).toEqual(bundle);
      expect(
        Object.keys(project.files).some((path) => /^(skills|docs|tests|rubric)\//.test(path)),
      ).toBe(false);
    },
  );
  it('consumes the packaged Skill and only its role/stage reference materials', () => {
    const bundle = revised((files) => {
      files['skills/0/A-teach.md'] = 'COURSE-SPECIFIC TEACHING';
      files['docs/0.md'] = 'ACTIVE REFERENCE';
      files['docs/1.md'] = 'FUTURE REFERENCE';
    });
    const { project } = validateProjectPackage(bundle);
    const stage = project.definition.milestones[0].stages[0];
    const skill = packagedStageSkill(project, stage, 'greeting:0', 'discussion');
    expect(skill.content['A-teach.md']).toContain('COURSE-SPECIFIC TEACHING');
    expect(skill.documents).toEqual([{ path: 'docs/0.md', text: 'ACTIVE REFERENCE' }]);
    expect(JSON.stringify(skill)).not.toContain('FUTURE REFERENCE');
    expect(() => packagedStageSkill(project, stage, 'greeting:0', 'coder')).toThrow('unavailable');
  });
  it('accepts bound teaching documents beyond the former prompt budget', () => {
    expect(() =>
      validateProjectPackage(
        revised((files) => {
          files['docs/1.md'] = 'large course reference\n'.repeat(8000);
        }),
      ),
    ).not.toThrow();
  });
  it.each([
    'systemPrompt',
    'commonRules',
    'goal',
    'title',
    'contract',
    'intro',
    'decision',
    'remediation',
    'starter plan',
    'combined fields',
    'project title',
    'language',
    'milestone teaching',
  ])('accepts large package-controlled %s without an arbitrary teaching prompt budget', (field) => {
    const bundle = revised((files) => {
      const spec = JSON.parse(files['project.json']);
      const large = 'course-controlled text '.repeat(2000);
      const milestone = spec.definition.milestones[0];
      if (field === 'project title') spec.definition.title = large;
      else if (field === 'language') spec.definition.language = large;
      else if (field === 'milestone teaching')
        milestone.teaching = { purpose: large, concepts: ['concept'] };
      else if (field === 'starter plan') files['skeleton/PLAN.md'] = large;
      else if (field === 'combined fields') {
        spec.definition.agents.mentor.systemPrompt = 'x'.repeat(8000);
        spec.definition.agents.commonRules = 'x'.repeat(8000);
        spec.definition.intro.say = 'x'.repeat(8000);
        milestone.goal = 'x'.repeat(8000);
      } else if (field === 'systemPrompt') spec.definition.agents.mentor.systemPrompt = large;
      else if (field === 'commonRules') spec.definition.agents.commonRules = large;
      else if (field === 'goal' || field === 'title' || field === 'contract')
        milestone[field] = large;
      else if (field === 'intro') spec.definition.intro.say = large;
      else if (field === 'decision') spec.definition.decisions[0].options[0].summary = large;
      else {
        // Only the failed-test teaching path reads this contract.
        for (const stage of milestone.stages)
          if ('reads' in stage)
            stage.reads = stage.reads.filter((read: string) => read !== 'contract');
        milestone.contract = large;
      }
      files['project.json'] = JSON.stringify(spec);
    });
    expect(() => validateProjectPackage(bundle)).not.toThrow();
  });
  it('counts package-derived evaluation feedback duplicated in failure tutoring', () => {
    const bundle = revised((files) => {
      const spec = JSON.parse(files['project.json']);
      spec.definition.agents.coder.systemPrompt = 'x'.repeat(17_000);
      const name = spec.runtime.evaluations.greeting;
      const evaluation = JSON.parse(files[name]);
      evaluation.cases = Array.from({ length: 40 }, (_, i) => ({
        id: `case-${i}`,
        label: 'y'.repeat(160),
        argv: ['python3'],
        stdout: '',
      }));
      files[name] = JSON.stringify(evaluation);
      files['project.json'] = JSON.stringify(spec);
    });
    expect(() => validateProjectPackage(bundle)).not.toThrow();
  });
  it('preserves large metadata that never enters a teaching prompt', () => {
    const bundle = revised((files) => {
      const spec = JSON.parse(files['project.json']);
      spec.definition.agents.mentor.teachingSystemPrompt = 'x'.repeat(40_000);
      spec.definition.milestones[0].quiz[0].explain = 'x'.repeat(40_000);
      files['project.json'] = JSON.stringify(spec);
    });
    expect(validateProjectPackage(bundle).bundle).toEqual(bundle);
  });
  it.each(['combined documents', 'repeated root Skill', 'JSON escapes', 'UTF-8'])(
    'counts %s in the per-stage teaching budget',
    (kind) => {
      const bundle = revised((files) => {
        const spec = JSON.parse(files['project.json']);
        const binding = spec.teaching[1];
        if (kind === 'combined documents') {
          files['docs/1.md'] = 'x'.repeat(20_000);
          files['docs/extra.md'] = 'y'.repeat(20_000);
          binding.documents.push('docs/extra.md');
        } else if (kind === 'repeated root Skill') {
          files[binding.entrypoint] = 'x'.repeat(3000);
          binding.sections = Array.from({ length: 16 }, (_, i) => {
            const name = `${String.fromCharCode(65 + i)}-teach.md`;
            const path = `skills/1/${name}`;
            files[path] = '';
            return { name, path };
          });
        } else files['docs/1.md'] = kind === 'UTF-8' ? '课'.repeat(11_000) : '"\n'.repeat(9000);
        files['project.json'] = JSON.stringify(spec);
      });
      expect(() => validateProjectPackage(bundle)).not.toThrow();
    },
  );
  it('preserves large bound references while retaining package file-size validation', () => {
    const bundle = revised((files) => {
      files['docs/1.md'] = 'x'.repeat(64 * 1024);
    });
    expect(validateProjectPackage(bundle).bundle.files['docs/1.md']).toHaveLength(64 * 1024);
    const oversized = revised((files) => {
      files['docs/1.md'] = 'x'.repeat(512 * 1024 + 1);
    });
    expect(() => validateProjectPackage(oversized)).toThrow();
  });
  it('rejects corrupt, missing, unsafe, excessive and unsupported resources before installation', () => {
    const bundle = packageBuiltin(source());
    const corrupt = structuredClone(bundle);
    corrupt.files['skeleton/PLAN.md'] = 'tampered';
    expect(() => validateProjectPackage(corrupt)).toThrow('checksum');
    const missing = structuredClone(bundle);
    delete missing.files['project.json'];
    expect(() => validateProjectPackage(missing)).toThrow('index');
    for (const path of [
      'skeleton/../secret',
      '/skeleton/secret',
      'skills/\\secret',
      'docs/.hidden',
      'docs/x\0y',
    ]) {
      expect(() =>
        validateProjectPackage(
          revised((files) => {
            files[path] = 'bad';
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      validateProjectPackage(
        revised((files) => {
          files['docs/big.md'] = 'x'.repeat(512 * 1024 + 1);
        }),
      ),
    ).toThrow();
    expect(() =>
      validateProjectPackage(
        revised((files) => {
          const spec = JSON.parse(files['project.json']);
          spec.runtime.profile = 'maven';
          files['project.json'] = canonicalJson(spec);
        }),
      ),
    ).toThrow('runtime profile');
    expect(() =>
      validateProjectPackage(
        revised((files) => {
          delete files['skills/1/A-teach.md'];
        }),
      ),
    ).toThrow('Missing');
    expect(() =>
      validateProjectPackage(
        revised((files) => {
          const spec = JSON.parse(files['project.json']);
          spec.runtime.sourceRoots = ['tests'];
          files['project.json'] = canonicalJson(spec);
        }),
      ),
    ).toThrow('private');
  });
  it.each(['skeleton/src', 'tests/greeting.json/extra.txt'])(
    'rejects files that conflict with resource directories: %s',
    (name) => {
      expect(() =>
        validateProjectPackage(
          revised((files) => {
            files[name] = 'conflicting file';
          }),
        ),
      ).toThrow('Project file conflicts with a resource directory');
    },
  );
  it.each(['src/greeting.py', 'src/greeting.py/nested'])(
    'rejects source roots that name or descend from a starter file: %s',
    (root) => {
      expect(() =>
        validateProjectPackage(
          revised((files) => {
            const spec = JSON.parse(files['project.json']);
            spec.runtime.sourceRoots = [root];
            files['project.json'] = JSON.stringify(spec);
          }),
        ),
      ).toThrow('Source root must be a directory');
    },
  );
  it('bounds the complete evaluation command, including private resources and its runtime UUID', () => {
    const bundle = packageBuiltin(source('greeting-python'));
    const { project } = validateProjectPackage(bundle);
    const spec = evaluationFor(project, 'greeting');
    const requestId = '12345678-1234-1234-1234-123456789012';
    const commandBytes = (padding: number) =>
      Buffer.byteLength(
        evaluationCommand(
          { ...spec, resources: { ...spec.resources, 'tests/padding.txt': 'x'.repeat(padding) } },
          requestId,
        ),
      );
    const privateBytes = Object.values(spec.resources!).reduce(
      (total, text) => total + Buffer.byteLength(text),
      0,
    );
    let accepted = 0,
      rejected = 24 * 1024 - privateBytes;
    expect(commandBytes(rejected)).toBeGreaterThan(MAX_COMMAND_BYTES);
    while (rejected - accepted > 1) {
      const candidate = Math.floor((accepted + rejected) / 2);
      if (commandBytes(candidate) <= MAX_COMMAND_BYTES) accepted = candidate;
      else rejected = candidate;
    }
    const padded = (padding: number) =>
      indexProjectFiles(bundle.entry.id, bundle.entry.version, {
        ...bundle.files,
        'tests/padding.txt': 'x'.repeat(padding),
      });
    const acceptedProject = validateProjectPackage(padded(accepted)).project;
    expect(
      Buffer.byteLength(evaluationCommand(evaluationFor(acceptedProject, 'greeting'), requestId)),
    ).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    expect(() => validateProjectPackage(padded(rejected))).toThrow(
      'Evaluation exceeds the sandbox 32 KiB command limit',
    );
  });
  it('counts UTF-8 bytes in generated build commands before accepting a package', () => {
    const withBuildPaths = (characters: number) =>
      revised((files) => {
        const spec = JSON.parse(files['project.json']);
        spec.runtime.buildSources = Array.from(
          { length: 128 },
          (_, index) => `src/${'课'.repeat(characters)}${index}.py`,
        );
        for (const name of spec.runtime.buildSources) files[`skeleton/${name}`] = '';
        files['project.json'] = JSON.stringify(spec);
      });
    const { project } = validateProjectPackage(withBuildPaths(70));
    expect(Buffer.byteLength(project.buildCommand!)).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    expect(() => validateProjectPackage(withBuildPaths(100))).toThrow(
      'Build sources exceed the sandbox 32 KiB command limit',
    );
  });
  it('rejects ZIP traversal, symlinks, extra files and false size indexes before decompression', async () => {
    const bundle = packageBuiltin(source());
    for (const mode of ['traversal', 'symlink', 'extra', 'size']) {
      const zip = new JSZip();
      for (const [name, text] of Object.entries(bundle.files))
        zip.file(`${bundle.entry.root}/${name}`, text);
      const entry = structuredClone(bundle.entry);
      if (mode === 'traversal') zip.file(`${bundle.entry.root}/docs/../escape`, 'bad');
      if (mode === 'extra') zip.file(`${bundle.entry.root}/docs/extra.md`, 'bad');
      if (mode === 'symlink')
        zip.file(`${bundle.entry.root}/skeleton/PLAN.md`, '', { unixPermissions: 0o120777 });
      if (mode === 'size') entry.files['project.json'].size = 0;
      const loaded = await JSZip.loadAsync(
        await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' }),
      );
      await expect(readClassroomProjects(loaded, [entry])).rejects.toThrow();
    }
  });
  it('exports deduplicated bindings, imports them and re-exports identical pinned resources', async () => {
    const bundle = packageBuiltin(source()),
      m = manifest(),
      files = new Map<string, Blob>();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const input = JSON.parse(init!.body as string);
      if (input.action === 'install')
        return Response.json({
          references: [
            {
              id: bundle.entry.id,
              version: bundle.entry.version,
              assetId: 'installed-template',
              checksum: bundle.entry.checksum,
            },
          ],
        });
      return Response.json({ projects: input.refs.map(() => bundle) });
    });
    try {
      await attachClassroomProjects('original', m, files);
      expect(m.formatVersion).toBe(2);
      expect(m.requiredCapabilities).toEqual(['pbl-v3-projects@1']);
      expect(m.pblProjects).toHaveLength(1);
      expect(files.size).toBe(Object.keys(bundle.files).length);
      const first = structuredClone(m);
      const zip = await archive(bundle);
      await installClassroomProjects(zip, m);
      expect(m.scenes[0].content).toMatchObject({ projectV3: { assetId: 'installed-template' } });
      await attachClassroomProjects('imported', m, new Map());
      expect(m).toEqual(first);
      expect(JSON.stringify(m)).not.toContain('installed-template');
    } finally {
      fetcher.mockRestore();
    }
  });
  it('declares written decision capabilities and rejects an undeclared archive before uploading it', async () => {
    const bundle = revised((files) => {
      const spec = JSON.parse(files['project.json']);
      spec.definition.decisions[0].requiresRationale = true;
      spec.definition.decisions[0].responseType = 'text';
      spec.definition.decisions[0].options = [];
      files['project.json'] = JSON.stringify(spec);
    });
    const m = manifest();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const input = JSON.parse(init!.body as string);
      if (input.action === 'install')
        return Response.json({
          references: [
            { ...source().ref, assetId: 'installed-template', checksum: bundle.entry.checksum },
          ],
        });
      return Response.json({ projects: input.refs.map(() => bundle) });
    });
    try {
      await attachClassroomProjects('original', m, new Map());
      expect(m.requiredCapabilities).toEqual(['pbl-v3-projects@1', DECISION_RESPONSE_CAPABILITY]);
      const zip = await archive(bundle);
      const undeclared = structuredClone(m);
      undeclared.requiredCapabilities = ['pbl-v3-projects@1'];
      fetcher.mockClear();
      await expect(installClassroomProjects(zip, undeclared)).rejects.toThrow(
        DECISION_RESPONSE_CAPABILITY,
      );
      expect(fetcher).not.toHaveBeenCalled();
      await installClassroomProjects(zip, m);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(m.scenes[0].content).toMatchObject({ projectV3: { checksum: bundle.entry.checksum } });
    } finally {
      fetcher.mockRestore();
    }
  });
  it.each(['{', 'null', '{}', '{"definition":{"decisions":[]}}'])(
    'rejects malformed descriptors through a validation error before installing: %s',
    async (descriptor) => {
      const bundle = revised((files) => {
        files['project.json'] = descriptor;
      });
      const m = manifest();
      m.formatVersion = 2;
      m.requiredCapabilities = ['pbl-v3-projects@1'];
      m.pblProjects = [bundle.entry];
      const fetcher = vi.spyOn(globalThis, 'fetch');
      try {
        await expect(installClassroomProjects(await archive(bundle), m)).rejects.toThrow(
          /Invalid (JSON|project definition)/,
        );
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        fetcher.mockRestore();
      }
    },
  );
  it('rejects unsupported formats/capabilities and unbound references; preserves ordinary v1 archives', () => {
    expect(() => validateClassroomPackageCompatibility(manifest())).not.toThrow();
    expect(() =>
      validateClassroomPackageCompatibility({ ...manifest(), formatVersion: 9 }),
    ).toThrow('version');
    expect(() =>
      validateClassroomPackageCompatibility({ ...manifest(), requiredCapabilities: ['unknown'] }),
    ).toThrow('capabilities');
    expect(() => bindPackageReferences(manifest().scenes, new Map())).toThrow('packaged');
    expect(
      validatePBLContent({ type: 'pbl', projectV3: { id: 'x', version: '1', assetId: 'a' } }).valid,
    ).toBe(false);
    expect(
      isPBLV3Reference({ id: 'x', version: '1', assetId: 'a', checksum: 'a'.repeat(64) }),
    ).toBe(true);
  });
  it('enumerates project assets per scene for copy/delete/collection reference maintenance', () => {
    const scenes = ['a', 'b'].map((id) => ({
      id,
      stageId: 'course',
      type: 'pbl' as const,
      title: id,
      order: 0,
      content: {
        type: 'pbl' as const,
        projectV3: { id: 'x', version: '1', assetId: 'asset', checksum: 'a'.repeat(64) },
      },
    }));
    const result = enumerateAssetManifest({ stage: {}, scenes });
    expect(result.entries).toEqual([{ ref: 'asset', kind: 'pbl-project' }]);
    expect(result.referenceCounts.get('asset')).toBe(2);
  });
  it
    .runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')
    .each(['greeting-python-lab', 'greeting-java'])(
    'executes the imported %s profile and private evaluation resources',
    async (id) => {
      const bundle = packageBuiltin(source(id));
      if (id === 'greeting-python-lab') {
        bundle.files['tests/check.py'] =
          'import sys,os\nsys.path.insert(0,os.path.join(os.getcwd(),"src"))\nfrom greeting import greet\nprint(greet("  Ada  "))\n';
        bundle.files['rubric/expected.txt'] = 'Hello, Ada!';
        bundle.files['tests/normalize.json'] = JSON.stringify({
          cases: [
            {
              id: 'private-resource',
              argv: ['python3', '{resources}/tests/check.py'],
              stdout: 'Hello, Ada!\n',
            },
          ],
        });
      }
      const { project } = validateProjectPackage(
        indexProjectFiles(bundle.entry.id, bundle.entry.version, bundle.files),
      );
      const dir = await mkdtemp(join(tmpdir(), 'pbl-package-profile-'));
      try {
        for (const [path, text] of Object.entries(project.files)) {
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), text);
        }
        const java = id === 'greeting-java';
        await writeFile(
          join(dir, java ? 'src/Greeting.java' : 'src/greeting.py'),
          java
            ? 'public class Greeting { public static void main(String[] args) { System.out.println("Hello, " + args[0].trim() + "!"); } }'
            : 'def greet(name):\n    return f"Hello, {name.strip()}!"\n',
        );
        await promisify(execFile)('/bin/sh', ['-c', project.buildCommand!], { cwd: dir });
        const spec = evaluationFor(project, 'normalize');
        const { stdout } = await promisify(execFile)(
          '/bin/sh',
          ['-c', evaluationCommand(spec, 'package-eval')],
          { cwd: dir },
        );
        expect(evaluationPassed(spec, 'package-eval', stdout)).toBe(true);
        expect(spec.resources).not.toHaveProperty('tests/normalize.json');
        expect(spec.resources).not.toHaveProperty('rubric/expected.txt');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
