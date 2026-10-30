import 'server-only';
import type { InstalledProject } from './catalog';
import { isProjectSource } from './workspace-files';
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import { sandboxInvalid } from '@/lib/sandbox/errors';

export function additionalBuildSources(
  project: InstalledProject,
  paths: readonly string[],
  extension: string,
) {
  return paths
    .filter(
      (path) =>
        !Object.hasOwn(project.files, path) &&
        path.endsWith(extension) &&
        isProjectSource(project, path),
    )
    .sort();
}

/** Preserve authored entrypoints; include new authorized sources without scanning private resources. */
export function currentBuildCommand(
  project: InstalledProject,
  paths: readonly string[],
): string | undefined {
  if (!project.buildCommand) return undefined;
  const profile =
    project.coursePackage?.descriptor.runtime.profile ??
    (project.definition.language === 'Java'
      ? 'java'
      : project.definition.language === 'Python'
        ? 'python3'
        : null);
  if (!profile) return project.buildCommand;
  const extension = profile === 'java' ? '.java' : '.py';
  const added = additionalBuildSources(project, paths, extension);
  if (!added.length) return project.buildCommand;
  const declared =
    project.coursePackage?.descriptor.runtime.buildSources ??
    Object.keys(project.files).filter((path) => path.endsWith(extension));
  const sources = [...new Set([...declared, ...added])].sort();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command =
    profile === 'java'
      ? `javac -d /tmp/pbl-project-build ${sources.map((path) => quote(`./${path}`)).join(' ')}`
      : `python3 -c ${quote(`import ast,pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ${JSON.stringify(sources)}]`)}`;
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
    throw sandboxInvalid(
      'Current build sources exceed the sandbox 32 KiB command limit.',
      'PBL_SOURCE_SIZE',
    );
  return command;
}
