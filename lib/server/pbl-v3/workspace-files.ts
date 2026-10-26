import 'server-only';
import type { InstalledProject } from './catalog';
import type { SandboxService } from '@/lib/server/sandbox/service';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { WORKSPACE_EXCLUDES } from '@/lib/server/sandbox/workspace-archive';

const excluded = new Set([...WORKSPACE_EXCLUDES, '.git', 'build', 'dist']);
export function validSourcePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    !!path &&
    path.length <= 4096 &&
    !/[\\\x00-\x1f]/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..' || excluded.has(part))
  );
}
/** Trusted course source roots opt in to additional files; legacy packages keep their closed file set. */
export function isProjectSource(project: InstalledProject, path: unknown): path is string {
  if (!validSourcePath(path)) return false;
  if (Object.hasOwn(project.files, path)) return true;
  return (
    !!project.sourceRoots?.some((root) => validSourcePath(root) && path.startsWith(`${root}/`)) &&
    /\.(?:java|py|js|ts|tsx|jsx|json|css|html|md|txt|xml|ya?ml)$/.test(path)
  );
}
export function assertProjectSource(
  project: InstalledProject,
  path: unknown,
): asserts path is string {
  if (!isProjectSource(project, path))
    throw sandboxInvalid('This path is outside the project source files.', 'PBL_SOURCE_PATH');
}
export async function projectFiles(
  service: SandboxService,
  environmentId: string,
  project: InstalledProject,
  signal?: AbortSignal,
) {
  const paths = project.sourceRoots
    ? (await service.listFiles(environmentId, signal))
        .filter((entry) => isProjectSource(project, entry.path))
        .map((entry) => entry.path)
    : Object.keys(project.files);
  const unique = [...new Set(paths)].sort();
  if (unique.length > 256)
    throw sandboxInvalid('Learning projects support at most 256 source files.', 'PBL_SOURCE_COUNT');
  for (const path of unique) assertProjectSource(project, path);
  return unique;
}
