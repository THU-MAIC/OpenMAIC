import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PBLProjectPackage } from '@openmaic/dsl';
import {
  projectSchema,
  projectAdmissionSchema,
  type StageDefinition,
  type AgentRole,
} from '@/lib/pbl/v3/domain/project/project-schema';
import { SandboxError } from '@/lib/sandbox/errors';
import { PROJECT_LIMITS, safeProjectPath } from '@/lib/pbl/v3/package-policy';
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import type { InstalledProject } from './catalog';
import { evaluationCommand } from './evaluation';
import { stageSkill } from './skills';
import { applicationLaunchCommand, applicationProbeCommand } from './application-command';
import { validSourcePath } from './workspace-files';

export { PROJECT_LIMITS, safeProjectPath } from '@/lib/pbl/v3/package-policy';
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
const path = z.string().refine(safeProjectPath, 'Invalid relative project path');
const section = z.object({ name: z.string().regex(/^[A-Z]-[a-z-]+\.md$/), path }).strict();
const binding = z
  .object({
    stage: z.string().min(1),
    role: z.enum(['mentor', 'discussion', 'planner', 'coder']),
    entrypoint: path,
    sections: z.array(section).min(1).max(16),
    documents: z.array(path).max(32),
  })
  .strict();
const descriptorSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string(),
    version: z.string(),
    definition: projectSchema,
    runtime: z
      .object({
        profile: z.enum(['python3', 'java']),
        sourceRoots: z.array(path).max(16),
        buildSources: z.array(path).min(1).max(128).optional(),
        evaluations: z.record(z.string(), path),
        application: z
          .object({
            title: z.string().trim().min(1).max(100),
            description: z.string().trim().min(1).max(2000),
            argv: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(512)
                  .refine((v) => !v.includes('\0')),
              )
              .min(2)
              .max(32),
            port: z
              .number()
              .int()
              .min(1024)
              .max(65535)
              .refine((v) => v !== 49983),
            healthPath: z
              .string()
              .regex(/^\/[a-zA-Z0-9_/-]*$/)
              .max(200),
          })
          .strict()
          .optional(),
      })
      .strict(),
    teaching: z.array(binding).min(1).max(256),
  })
  .strict();
export type ProjectDescriptor = z.infer<typeof descriptorSchema>;

function teachingResources(
  bundle: PBLProjectPackage,
  active: ProjectDescriptor['teaching'][number],
) {
  const root = bundle.files[active.entrypoint];
  return {
    content: Object.fromEntries(
      active.sections.map((s) => [s.name, `${root}\n\n${bundle.files[s.path]}`]),
    ),
    progression: ['SKILL.md', ...active.sections.map((s) => s.name)],
    documents: active.documents.map((path) => ({ path, text: bundle.files[path] })),
  };
}

const evaluationSchema = z
  .object({
    prepare: z.array(z.string().max(16_384)).min(1).max(128).optional(),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).max(160).optional(),
            argv: z.array(z.string().max(16_384)).min(1).max(128),
            stdout: z.string().max(65_536),
            stdin: z.string().max(65_536).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

function invalid(message: string): never {
  throw new SandboxError('PBL_PACKAGE_INVALID', 400, message);
}
function parseJson(text: string | undefined, name: string): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return invalid(`Invalid JSON in ${name}.`);
  }
}
export function projectStages(
  project: InstalledProject | { definition: ProjectDescriptor['definition'] },
) {
  const result: { key: string; stage: StageDefinition }[] = [];
  for (const milestone of project.definition.milestones)
    milestone.stages.forEach((stage, i) => result.push({ key: `${milestone.id}:${i}`, stage }));
  return result;
}

export function indexProjectFiles(
  id: string,
  version: string,
  files: Record<string, string>,
): PBLProjectPackage {
  const index = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, { size: Buffer.byteLength(files[name]), sha256: sha256(files[name]) }]),
  );
  const checksum = sha256(canonicalJson({ id, version, entrypoint: 'project.json', files: index }));
  return {
    entry: {
      id,
      version,
      checksum,
      root: `pbl/${checksum}`,
      entrypoint: 'project.json',
      files: index,
    },
    files,
  };
}

/** Validates only. No sandbox, filesystem extraction, global Skills or command execution. */
export function validateProjectPackage(
  input: unknown,
  purpose: 'install' | 'resolve' = 'install',
): {
  bundle: PBLProjectPackage;
  project: InstalledProject;
} {
  const shape = z
    .object({
      entry: z
        .object({
          id: z.string().regex(/^[a-z0-9-]{1,80}$/),
          version: z.string().regex(/^[a-zA-Z0-9.-]{1,40}$/),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          root: path,
          entrypoint: z.literal('project.json'),
          files: z.record(
            path,
            z
              .object({
                size: z.number().int().nonnegative().max(PROJECT_LIMITS.fileBytes),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          ),
        })
        .strict(),
      files: z.record(path, z.string().max(PROJECT_LIMITS.fileBytes)),
    })
    .strict()
    .safeParse(input);
  if (!shape.success) return invalid(`Invalid project package: ${shape.error.issues[0]?.message}`);
  const bundle = shape.data;
  const names = Object.keys(bundle.files);
  if (
    !names.length ||
    names.length > PROJECT_LIMITS.files ||
    names.length !== Object.keys(bundle.entry.files).length
  )
    return invalid('Project file index does not match its resources or exceeds the file limit.');
  const fileNames = new Set(names);
  for (const name of names) {
    let directory = name;
    while (directory.includes('/')) {
      directory = directory.slice(0, directory.lastIndexOf('/'));
      if (fileNames.has(directory))
        return invalid(`Project file conflicts with a resource directory: ${directory}`);
    }
  }
  let total = 0;
  for (const name of names) {
    if (name !== 'project.json' && !/^(skeleton|skills|docs|tests|rubric)\//.test(name))
      return invalid(`Unsupported project resource path: ${name}`);
    const text = bundle.files[name],
      indexed = bundle.entry.files[name];
    const size = Buffer.byteLength(text);
    total += size;
    if (!indexed || indexed.size !== size || indexed.sha256 !== sha256(text))
      return invalid(`Size or checksum mismatch: ${name}`);
    if (size > PROJECT_LIMITS.fileBytes || total > PROJECT_LIMITS.bytes || text.includes('\0'))
      return invalid(`Project resource limit exceeded: ${name}`);
  }
  const indexed = indexProjectFiles(bundle.entry.id, bundle.entry.version, bundle.files);
  if (indexed.entry.checksum !== bundle.entry.checksum || bundle.entry.root !== indexed.entry.root)
    return invalid('Project content checksum or archive root does not match.');
  const descriptor = descriptorSchema.safeParse(
    parseJson(bundle.files['project.json'], 'project.json'),
  );
  if (!descriptor.success)
    return invalid(
      `Unsupported project definition or runtime profile: ${descriptor.error.issues[0]?.message}`,
    );
  if (purpose === 'install') {
    const admission = projectAdmissionSchema.safeParse(descriptor.data.definition);
    if (!admission.success)
      return invalid(`Invalid project definition: ${admission.error.issues[0]?.message}`);
  }
  const config = descriptor.data;
  const identifier = (value: string) =>
    /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !Object.hasOwn(Object.prototype, value);
  const uniqueIds = (items: { id: string }[]) =>
    items.every(({ id }) => identifier(id)) &&
    new Set(items.map(({ id }) => id)).size === items.length;
  if (!uniqueIds(config.definition.milestones) || !uniqueIds(config.definition.decisions))
    return invalid('Milestone and decision IDs must be safe and unique.');
  for (const decision of config.definition.decisions)
    if (!uniqueIds(decision.options))
      return invalid(`Decision option IDs must be safe and unique: ${decision.id}`);
  for (const milestone of config.definition.milestones) {
    if (
      milestone.decisions.some(
        (id) => !config.definition.decisions.some((decision) => decision.id === id),
      )
    )
      return invalid(`Unknown decision in ${milestone.id}`);
    if (milestone.quiz.some((question) => question.answer >= question.options.length))
      return invalid(`Invalid quiz answer in ${milestone.id}`);
    if (
      !milestone.quiz.length &&
      milestone.stages.some((s) => s.kind === 'check' && s.checker === 'quiz')
    )
      return invalid(`Missing quiz questions in ${milestone.id}`);
  }
  if (projectStages(config).length > 256)
    return invalid('Project packages support at most 256 stages.');
  if (
    config.id !== bundle.entry.id ||
    config.version !== bundle.entry.version ||
    config.definition.id !== config.id
  )
    return invalid('Project identity does not match the file index.');
  const resource = (name: string, prefix: string) => {
    if (!name.startsWith(prefix + '/') || !Object.hasOwn(bundle.files, name))
      return invalid(`Missing or misplaced project resource: ${name}`);
    return bundle.files[name];
  };
  const privateBytes = names
    .filter(
      (name) =>
        /^tests\//.test(name) &&
        !Object.values(config.runtime.evaluations).includes(name) &&
        !config.definition.visibility.answerKeys.includes(name),
    )
    .reduce((sum, name) => sum + Buffer.byteLength(bundle.files[name]), 0);
  if (privateBytes > 24 * 1024)
    return invalid('Evaluation resources exceed the supported 24 KiB budget.');
  // Course packages cannot request deployment services or bypass the registered profile.
  if (config.definition.services?.length)
    return invalid('Project packages do not support service declarations.');
  if (
    config.definition.paths.requirements !== 'docs' ||
    config.definition.paths.pedagogy !== 'skills' ||
    config.definition.paths.skeleton !== 'skeleton' ||
    config.definition.paths.tests !== 'tests' ||
    config.definition.paths.rubric !== 'rubric'
  )
    return invalid('Project paths must use docs/, skills/, skeleton/, tests/ and rubric/.');
  const evaluations: InstalledProject['evaluations'] = {};
  for (const [milestone, name] of Object.entries(config.runtime.evaluations)) {
    if (!config.definition.milestones.some((m) => m.id === milestone))
      return invalid(`Unknown evaluation milestone: ${milestone}`);
    const parsed = evaluationSchema.safeParse(parseJson(resource(name, 'tests'), name));
    if (!parsed.success) return invalid(`Invalid evaluation resource: ${name}`);
    const spec = parsed.data;
    const allowed = config.runtime.profile === 'java' ? ['java', 'javac', 'python3'] : ['python3'];
    if (
      [...(spec.prepare ? [spec.prepare] : []), ...spec.cases.map((c) => c.argv)].some(
        (argv) => !allowed.includes(argv[0]),
      )
    )
      return invalid(`Unsupported evaluation executable in ${name}`);
    if (new Set(spec.cases.map((c) => c.id)).size !== spec.cases.length)
      return invalid(`Duplicate evaluation case in ${name}`);
    evaluations[milestone] = spec;
    const resources = Object.fromEntries(
      names
        .filter(
          (name) =>
            /^tests\//.test(name) &&
            !Object.values(config.runtime.evaluations).includes(name) &&
            !config.definition.visibility.answerKeys.includes(name),
        )
        .map((name) => [name, bundle.files[name]]),
    );
    if (Buffer.byteLength(JSON.stringify({ ...spec, resources })) > 48 * 1024)
      return invalid(`Evaluation payload exceeds 48 KiB: ${name}`);
    // Runtime request IDs are UUIDs. Account for the complete encoded runner, not just its JSON.
    if (
      Buffer.byteLength(
        evaluationCommand({ ...spec, resources }, '00000000-0000-0000-0000-000000000000'),
      ) > MAX_COMMAND_BYTES
    )
      return invalid(`Evaluation exceeds the sandbox 32 KiB command limit: ${name}`);
  }
  const files = Object.fromEntries(
    names
      .filter((name) => name.startsWith('skeleton/'))
      .map((name) => [name.slice(9), bundle.files[name]]),
  );
  if (!Object.keys(files).length || !Object.hasOwn(files, 'PLAN.md'))
    return invalid('Starter files must include skeleton/PLAN.md.');
  if (
    Object.keys(files).length > 256 ||
    Object.keys(files).some((name) => !validSourcePath(name)) ||
    config.runtime.sourceRoots.some((name) => !validSourcePath(name)) ||
    Object.values(files).reduce((n, text) => n + Buffer.byteLength(text), 0) > 1_048_576
  )
    return invalid(
      'Starter files exceed the supported source paths, 256 files or 1 MiB snapshot limit.',
    );
  for (const root of config.runtime.sourceRoots)
    if (Object.keys(files).some((name) => root === name || root.startsWith(`${name}/`)))
      return invalid(`Source root must be a directory, but conflicts with a starter file: ${root}`);
  // Assessment and teaching resources must never become learner source paths.
  if (Object.keys(files).some((name) => /^(skills|docs|tests|rubric)(\/|$)/.test(name)))
    return invalid('Starter files overlap private course resources.');
  if (config.runtime.sourceRoots.some((root) => /^(skills|docs|tests|rubric)(\/|$)/.test(root)))
    return invalid('Source roots overlap private course resources.');
  const application = config.runtime.application;
  if (
    application &&
    (config.runtime.profile !== 'python3' ||
      application.argv[0] !== 'python3' ||
      !safeProjectPath(application.argv[1]) ||
      !application.argv[1].endsWith('.py') ||
      !Object.hasOwn(files, application.argv[1]))
  )
    return invalid('Applications require a Python starter entrypoint and the python3 profile.');
  if (application) {
    applicationLaunchCommand(application.argv);
    applicationProbeCommand(Object.keys(files).sort(), application.port, application.healthPath);
  }
  const buildSources = config.runtime.buildSources;
  if (
    buildSources?.some(
      (name) =>
        !Object.hasOwn(files, name) ||
        !(config.runtime.profile === 'java' ? name.endsWith('.java') : name.endsWith('.py')),
    )
  )
    return invalid('Build sources must name starter source files for this runtime profile.');
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  const buildCommand = buildSources
    ? config.runtime.profile === 'java'
      ? `javac -d /tmp/pbl-project-build ${buildSources.map((name) => quote(`./${name}`)).join(' ')}`
      : `python3 -c ${quote(`import ast,pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ${JSON.stringify(buildSources)}]`)}`
    : undefined;
  if (buildCommand && Buffer.byteLength(buildCommand) > MAX_COMMAND_BYTES)
    return invalid('Build sources exceed the sandbox 32 KiB command limit.');
  const keys = new Set<string>();
  for (const item of config.teaching) {
    const stage = projectStages(config).find((s) => s.key === item.stage)?.stage;
    if (!stage || ('agent' in stage && item.role !== stage.agent))
      return invalid(`Invalid teaching role/stage binding: ${item.stage}`);
    if (keys.has(item.stage)) return invalid(`Duplicate teaching binding: ${item.stage}`);
    keys.add(item.stage);
    resource(item.entrypoint, 'skills');
    if (new Set(item.sections.map((s) => s.name)).size !== item.sections.length)
      return invalid(`Duplicate teaching section: ${item.stage}`);
    for (const s of item.sections) resource(s.path, 'skills');
    for (const doc of item.documents) resource(doc, 'docs');
  }
  for (const { key, stage } of projectStages(config)) {
    if (stage.kind === 'course')
      return invalid('Embedded course stages are not supported by package version 1.');
    if ('agent' in stage) {
      if (!config.teaching.some((item) => item.stage === key && item.role === stage.agent))
        return invalid(`Missing role-bound teaching resources: ${key}`);
      if (stage.kind === 'produce' && stage.compileBeforeReview && !buildCommand)
        return invalid(`Missing build sources for ${key}`);
    }
  }
  for (const milestone of config.definition.milestones) {
    for (const ref of milestone.tests) resource(ref, 'tests');
    if (
      milestone.stages.some((s) => s.kind === 'check' && s.checker === 'tests') &&
      !evaluations[milestone.id]
    )
      return invalid(`Missing evaluation for ${milestone.id}`);
    for (const stage of milestone.stages)
      if (stage.kind === 'check') {
        for (const ref of stage.evaluation?.rubricRefs ?? []) resource(ref, 'rubric');
        for (const ref of stage.evaluation?.evaluatorRefs ?? []) resource(ref, 'tests');
        if (stage.evaluation?.capabilityIds.some((id) => id !== 'exit-code'))
          return invalid('Unsupported evaluation capability.');
      }
  }
  for (const agent of ['mentor', 'discussion', 'planner', 'coder'] as const)
    for (const ref of config.definition.agents[agent].skillPaths) resource(ref, 'skills');
  for (const ref of config.definition.visibility.answerKeys) resource(ref, 'rubric');
  for (const ref of config.definition.visibility.testSupport) resource(ref, 'tests');
  for (const refs of Object.values(config.definition.visibility.roleViews))
    for (const ref of refs) resource(ref, 'docs');
  const project: InstalledProject = {
    ref: { id: config.id, version: config.version },
    definition: config.definition,
    files,
    sourceRoots: config.runtime.sourceRoots,
    evaluations,
    application,
    buildCommand,
    coursePackage: { bundle, descriptor: config },
  };
  return { bundle, project };
}

/** Convert public built-ins through the same contract used by imported projects. */
export function packageBuiltin(project: InstalledProject): PBLProjectPackage {
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(project.files).map(([name, text]) => [`skeleton/${name}`, text]),
  );
  const teaching: ProjectDescriptor['teaching'] = [];
  for (const { key, stage } of projectStages(project))
    if ('agent' in stage) {
      const skill = stageSkill(stage),
        prefix = `skills/${teaching.length}`;
      files[`${prefix}/SKILL.md`] =
        'Use the active section only. Follow the server-controlled review and progression protocol.';
      const sections = Object.entries(skill.content).map(([name, text]) => {
        files[`${prefix}/${name}`] = text;
        return { name, path: `${prefix}/${name}` };
      });
      const doc = `docs/${teaching.length}.md`;
      files[doc] =
        stage.kind === 'mentor_say'
          ? stage.say
          : stage.kind === 'produce'
            ? `Produce and review ${stage.writes}.`
            : 'Discuss the current project decisions.';
      teaching.push({
        stage: key,
        role: stage.agent,
        entrypoint: `${prefix}/SKILL.md`,
        sections,
        documents: [doc],
      });
    }
  const evaluations = Object.fromEntries(
    Object.entries(project.evaluations).map(([id, spec]) => {
      const name = `tests/${id}.json`;
      files[name] = canonicalJson(JSON.parse(JSON.stringify(spec)));
      return [id, name];
    }),
  );
  const profile = project.definition.language === 'Java' ? 'java' : 'python3';
  const descriptor = {
    formatVersion: 1,
    ...project.ref,
    definition: {
      ...project.definition,
      paths: { ...project.definition.paths, requirements: 'docs', pedagogy: 'skills' },
    },
    runtime: {
      profile,
      sourceRoots: project.sourceRoots ?? [],
      ...(project.buildCommand
        ? {
            buildSources: Object.keys(project.files).filter((p) =>
              p.endsWith(profile === 'java' ? '.java' : '.py'),
            ),
          }
        : {}),
      evaluations,
    },
    teaching,
  };
  files['project.json'] = canonicalJson(descriptor);
  return validateProjectPackage(indexProjectFiles(project.ref.id, project.ref.version, files))
    .bundle;
}

export function packagedStageSkill(
  project: InstalledProject,
  stage: StageDefinition,
  key: string,
  role: AgentRole,
) {
  if (!project.coursePackage)
    return { ...stageSkill(stage), documents: [] as { path: string; text: string }[] };
  const { bundle, descriptor } = project.coursePackage;
  const active = descriptor.teaching.find((b) => b.stage === key && b.role === role);
  if (!active && !('agent' in stage))
    return {
      content: {} as Record<string, string>,
      progression: ['SKILL.md'],
      documents: [] as { path: string; text: string }[],
    };
  if (!active) return invalid(`Teaching resources are unavailable for ${key}/${role}`);
  return teachingResources(bundle, active);
}
