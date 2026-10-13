/**
 * PBL v2 — lightweight static checks for git pushes (slice-3 lite).
 *
 * Pure, file-list-only checks over a push's changed paths. They are the
 * "lightweight static feedback" fired on `git push` before the heavier
 * LLM + rubric evaluation (slice 4). No file contents, no network: the push
 * webhook payload already carries added/modified/removed paths, so these run
 * in-process and post back to Gitea as a commit status.
 *
 * The richer ArkTS rubric `staticChecks` (structure, ArkUI idioms, resource
 * wiring) live in the domain profile and extend this — see
 * `lib/pbl/v2/domains`.
 */

export type GitStaticLevel = 'info' | 'warn' | 'error';

export interface GitStaticFinding {
  level: GitStaticLevel;
  message: string;
  /** Relative path the finding is about, when applicable. */
  file?: string;
}

/** File extensions the template accepts as source/config (everything else flags a warn). */
const KNOWN_EXTENSIONS = new Set([
  'ets',
  'ts',
  'js',
  'json',
  'json5',
  'md',
  'txt',
  'gitignore',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'gif',
  'ico',
  'mp3',
  'wav',
  'mp4',
  'avi',
  'hvigorw',
  'bat',
  'sh',
  'properties',
  'cfg',
]);

/** Assets that should live under `resources`/`media`, not `ets`. */
const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'gif',
  'ico',
  'mp3',
  'wav',
  'mp4',
  'avi',
]);

const ARKTS_EXTENSIONS = new Set(['ets', 'ts']);

function extensionOf(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function hasUnknownExtension(path: string): boolean {
  // Dotfiles like `.gitignore` have no extension and are always acceptable.
  if (path.startsWith('.')) return false;
  const ext = extensionOf(path);
  return ext !== '' && !KNOWN_EXTENSIONS.has(ext);
}

/**
 * Compute lightweight static feedback for one push. Pure: consumes the
 * changed-file lists from a parsed push webhook and returns findings sorted
 * most-severe-first.
 */
export function runLightweightStaticCheck(input: {
  added: string[];
  modified: string[];
  removed: string[];
}): GitStaticFinding[] {
  const findings: GitStaticFinding[] = [];

  const changed = [...input.added, ...input.modified];
  const arktsChanged = changed.filter((p) => ARKTS_EXTENSIONS.has(extensionOf(p)));
  const unknown = changed.filter(hasUnknownExtension);
  const assetsInSource = changed.filter(
    (p) => ASSET_EXTENSIONS.has(extensionOf(p)) && p.includes('/ets/'),
  );

  if (changed.length === 0 && input.removed.length === 0) {
    findings.push({ level: 'info', message: 'Push 未包含文件改动。' });
  }

  for (const path of unknown) {
    findings.push({
      level: 'warn',
      message: `未知文件类型 .${extensionOf(path)}（不在模板白名单内）。`,
      file: path,
    });
  }

  for (const path of assetsInSource) {
    findings.push({
      level: 'warn',
      message: '资源文件放到了 ets 源码目录，建议移到 resources/base/media。',
      file: path,
    });
  }

  if (input.removed.length > 0) {
    findings.push({
      level: 'info',
      message: `删除了 ${input.removed.length} 个文件（如涉及页面路由请同步更新 main_pages.json）。`,
    });
  }

  if (arktsChanged.length > 0) {
    findings.push({
      level: 'info',
      message: `改动 ${arktsChanged.length} 个 ArkTS/TS 源文件：${arktsChanged.join(', ')}。`,
    });
  }

  return findings;
}

/** Sort findings most-severe-first so a merged set (generic + domain) opens
 *  with its most important item for the commit-status description. */
export function sortStaticFindings(findings: GitStaticFinding[]): GitStaticFinding[] {
  const rank: Record<GitStaticLevel, number> = { error: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Derive a single commit-status state from findings. */
export function staticFindingsState(findings: GitStaticFinding[]): 'success' | 'warning' | 'error' {
  if (findings.some((f) => f.level === 'error')) return 'error';
  if (findings.some((f) => f.level === 'warn')) return 'warning';
  return 'success';
}

/** Human-readable one-line summary for a commit-status description. */
export function summarizeStaticFindings(findings: GitStaticFinding[]): string {
  if (findings.length === 0) return '无改动。';
  const first = findings[0]!;
  const rest = findings.length > 1 ? `（另 ${findings.length - 1} 项）` : '';
  return `${first.message}${rest}`;
}
