import type { ClassroomManifest, ManifestScene } from '@/lib/export/classroom-zip-types';

export type OfflineCapability = 'fully' | 'basic' | 'requires-network';
export type OfflineIssueSeverity = 'blocking' | 'degraded' | 'notice';

export type OfflineIssueCode =
  | 'invalid-manifest'
  | 'missing-package-asset'
  | 'empty-interactive-scene'
  | 'remote-interactive-page'
  | 'external-script'
  | 'external-stylesheet'
  | 'external-frame'
  | 'remote-api'
  | 'remote-module'
  | 'remote-media'
  | 'remote-image'
  | 'external-link'
  | 'external-resource'
  | 'runtime-local-resource';

export interface OfflineAuditIssue {
  code: OfflineIssueCode;
  severity: OfflineIssueSeverity;
  message: string;
  path: string;
  url?: string;
  sceneIndex?: number;
  sceneTitle?: string;
}

export interface OfflineAuditSummary {
  blocking: number;
  degraded: number;
  notice: number;
  externalOrigins: string[];
  affectedScenes: number;
}

export interface CourseOfflineAudit {
  capability: OfflineCapability;
  label: string;
  description: string;
  issues: OfflineAuditIssue[];
  summary: OfflineAuditSummary;
  auditedAt: string;
}

export interface CourseOfflineAuditOptions {
  /** ZIP/folder paths, when available, used to verify relative assets. */
  packagePaths?: Iterable<string>;
  /** Treat this absolute origin as app-local instead of third-party. */
  appOrigin?: string;
  /** Maximum returned issues, protecting the UI from malformed HTML. */
  maxIssues?: number;
}

interface ScanContext {
  issues: OfflineAuditIssue[];
  seen: Set<string>;
  packagePaths: Set<string> | null;
  appOrigin?: string;
  maxIssues: number;
}

interface SceneContext {
  sceneIndex?: number;
  sceneTitle?: string;
}

const CAPABILITY_COPY: Record<
  OfflineCapability,
  Pick<CourseOfflineAudit, 'label' | 'description'>
> = {
  fully: {
    label: '完全离线',
    description: '课程内容和互动资源均可在断网环境中使用。',
  },
  basic: {
    label: '基础离线',
    description: '主要课程可离线打开，少量媒体、链接或附加内容需要网络。',
  },
  'requires-network': {
    label: '需要网络',
    description: '课程包含联网脚本、接口或外部互动页面，断网时关键功能会受影响。',
  },
};

const REMOTE_PROTOCOL_RE = /^(?:https?:|wss?:)\/\//i;
const SCHEME_RELATIVE_RE = /^\/\//;
const NON_NETWORK_SCHEME_RE = /^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i;

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePackagePath(value: string): string {
  return safelyDecode(value.split(/[?#]/, 1)[0])
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

function decodeHtmlUrl(value: string): string {
  return value
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#x3a;/gi, ':')
    .replace(/&#58;/g, ':');
}

function isRemoteUrl(value: string): boolean {
  const url = decodeHtmlUrl(value);
  return REMOTE_PROTOCOL_RE.test(url) || SCHEME_RELATIVE_RE.test(url);
}

function isAppLocalAbsoluteUrl(value: string, appOrigin?: string): boolean {
  if (!appOrigin || !isRemoteUrl(value)) return false;
  try {
    return new URL(value, appOrigin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

function isRuntimeLocalReference(value: string): boolean {
  const url = decodeHtmlUrl(value);
  return (
    !NON_NETWORK_SCHEME_RE.test(url) &&
    !isRemoteUrl(url) &&
    (/^\//.test(url) || /^\.\.?\//.test(url))
  );
}

function externalOrigin(value?: string): string | undefined {
  if (!value || !isRemoteUrl(value)) return undefined;
  try {
    return new URL(value, 'https://scheme-relative.invalid').origin;
  } catch {
    return undefined;
  }
}

function addIssue(context: ScanContext, issue: OfflineAuditIssue, scene: SceneContext = {}): void {
  if (context.issues.length >= context.maxIssues) return;
  const merged = { ...issue, ...scene };
  const key = [merged.code, merged.path, merged.url ?? '', merged.sceneIndex ?? ''].join('|');
  if (context.seen.has(key)) return;
  context.seen.add(key);
  context.issues.push(merged);
}

function issueForHtmlReference(
  context: ScanContext,
  tag: string,
  attribute: string,
  value: string,
  path: string,
  scene: SceneContext,
  tagSource: string,
): void {
  const url = decodeHtmlUrl(value);
  const remote = isRemoteUrl(url);
  const runtimeLocal = isRuntimeLocalReference(url);
  if (!remote && !runtimeLocal) return;

  const rel = /\brel\s*=\s*["']?([^\s"'>]+)/i.exec(tagSource)?.[1]?.toLowerCase();
  const resourceName = url.length > 180 ? `${url.slice(0, 177)}…` : url;
  let code: OfflineIssueCode = 'external-resource';
  let severity: OfflineIssueSeverity = 'degraded';
  let message = `外部资源 ${resourceName} 在断网时不可用`;

  if (tag === 'script') {
    code = 'external-script';
    severity = 'blocking';
    message = `互动页面依赖脚本 ${resourceName}`;
  } else if (tag === 'link' && ['stylesheet', 'modulepreload', 'preload'].includes(rel ?? '')) {
    code = 'external-stylesheet';
    severity = rel === 'stylesheet' ? 'blocking' : 'degraded';
    message = `互动页面依赖样式或预加载资源 ${resourceName}`;
  } else if (['iframe', 'embed', 'object'].includes(tag)) {
    code = 'external-frame';
    severity = 'blocking';
    message = `互动页面嵌入外部页面 ${resourceName}`;
  } else if (tag === 'form' || attribute === 'action' || attribute === 'formaction') {
    code = 'remote-api';
    severity = 'blocking';
    message = `互动操作需要访问 ${resourceName}`;
  } else if (['audio', 'video', 'source', 'track'].includes(tag)) {
    code = 'remote-media';
    message = `音视频资源 ${resourceName} 在断网时不可用`;
  } else if (tag === 'img' || attribute === 'poster') {
    code = 'remote-image';
    message = `图片资源 ${resourceName} 在断网时不可用`;
  } else if (tag === 'a' && attribute === 'href') {
    code = 'external-link';
    severity = 'notice';
    message = `扩展链接 ${resourceName} 需要联网访问`;
  }

  if (isAppLocalAbsoluteUrl(url, context.appOrigin) || runtimeLocal) {
    if (context.packagePaths?.has(normalizePackagePath(url))) return;
    code = 'runtime-local-resource';
    severity = ['script', 'iframe', 'embed', 'object'].includes(tag) ? 'blocking' : 'degraded';
    message = `互动页面引用运行时资源 ${resourceName}，离线前需确认已缓存`;
  }

  addIssue(context, { code, severity, message, path, url }, scene);
}

/** Scan one embedded interactive page without executing its HTML or scripts. */
export function auditInteractiveHtml(
  html: string,
  options: CourseOfflineAuditOptions = {},
  location = 'interactive.html',
): OfflineAuditIssue[] {
  const context = createScanContext(options);
  scanInteractiveHtml(html, context, location, {});
  return context.issues;
}

function createScanContext(options: CourseOfflineAuditOptions): ScanContext {
  const maxIssues = Number.isFinite(options.maxIssues)
    ? Math.max(0, Math.floor(options.maxIssues ?? 250))
    : 250;
  return {
    issues: [],
    seen: new Set(),
    packagePaths: options.packagePaths
      ? new Set(Array.from(options.packagePaths, normalizePackagePath))
      : null,
    appOrigin: options.appOrigin,
    maxIssues,
  };
}

function scanInteractiveHtml(
  html: string,
  context: ScanContext,
  path: string,
  scene: SceneContext,
): void {
  const source = html.slice(0, 5_000_000).replace(/<!--[^]*?-->/g, '');
  const attributePattern =
    /<([a-z][\w:-]*)\b([^>]*?\b(src|href|poster|action|formaction|data)\s*=\s*(?:(["'])(.*?)\4|([^\s"'=<>`]+))[^>]*)>/gi;

  for (const match of source.matchAll(attributePattern)) {
    issueForHtmlReference(
      context,
      match[1].toLowerCase(),
      match[3].toLowerCase(),
      match[5] ?? match[6] ?? '',
      path,
      scene,
      match[0],
    );
  }

  const srcsetPattern =
    /<([a-z][\w:-]*)\b[^>]*?\bsrcset\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+))[^>]*>/gi;
  for (const match of source.matchAll(srcsetPattern)) {
    for (const candidate of (match[3] ?? match[4] ?? '').split(',')) {
      const value = candidate.trim().split(/\s+/, 1)[0];
      issueForHtmlReference(
        context,
        match[1].toLowerCase(),
        'srcset',
        value,
        path,
        scene,
        match[0],
      );
    }
  }

  const cssUrlPattern = /(?:url\(\s*(["']?)(.*?)\1\s*\)|@import\s+(?:url\(\s*)?(["'])(.*?)\3)/gi;
  for (const match of source.matchAll(cssUrlPattern)) {
    const value = match[2] ?? match[4] ?? '';
    if (!isRemoteUrl(value) && !isRuntimeLocalReference(value)) continue;
    const isImport = /^@import/i.test(match[0]);
    issueForHtmlReference(
      context,
      isImport ? 'link' : 'style',
      'href',
      value,
      path,
      scene,
      isImport ? '<link rel="stylesheet">' : '<style>',
    );
  }

  const remoteApiPattern =
    /\b(fetch|axios\.(?:get|post|put|patch|delete)|new\s+(?:WebSocket|EventSource)|\.open)\s*\(\s*(["'`])([^"'`]+)\2/gi;
  for (const match of source.matchAll(remoteApiPattern)) {
    const value = decodeHtmlUrl(match[3]);
    if (!isRemoteUrl(value) && !/^\/?api\//i.test(value)) continue;
    addIssue(
      context,
      {
        code: 'remote-api',
        severity: 'blocking',
        message: `互动逻辑通过 ${match[1]} 访问联网接口`,
        path,
        url: value,
      },
      scene,
    );
  }

  const remoteModulePattern = /(?:\bfrom\s*|\bimport\s*\(\s*)(["'`])((?:https?:)?\/\/[^"'`]+)\1/gi;
  for (const match of source.matchAll(remoteModulePattern)) {
    addIssue(
      context,
      {
        code: 'remote-module',
        severity: 'blocking',
        message: '互动逻辑需要在线加载 JavaScript 模块',
        path,
        url: decodeHtmlUrl(match[2]),
      },
      scene,
    );
  }
}

function classifyManifestUrl(
  key: string,
): Pick<OfflineAuditIssue, 'code' | 'severity' | 'message'> {
  const normalizedKey = key.toLowerCase();
  if (/href|link|sourceurl/.test(normalizedKey)) {
    return { code: 'external-link', severity: 'notice', message: '课程包含需要联网访问的扩展链接' };
  }
  if (/api|endpoint|websocket/.test(normalizedKey)) {
    return { code: 'remote-api', severity: 'blocking', message: '课程内容依赖联网接口' };
  }
  if (/video|audio|media/.test(normalizedKey)) {
    return { code: 'remote-media', severity: 'degraded', message: '课程包含未打包的在线音视频' };
  }
  if (/image|poster|thumbnail|avatar|background|src|url/.test(normalizedKey)) {
    return {
      code: 'remote-image',
      severity: 'degraded',
      message: '课程包含未打包的在线图片或资源',
    };
  }
  return { code: 'external-resource', severity: 'degraded', message: '课程包含外部资源' };
}

function scanManifestObject(
  value: unknown,
  context: ScanContext,
  path: string,
  scene: SceneContext,
  visited: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (!isRemoteUrl(value) || isAppLocalAbsoluteUrl(value, context.appOrigin)) return;
    const classification = classifyManifestUrl(path.split('.').at(-1) ?? '');
    addIssue(context, { ...classification, path, url: value }, scene);
    return;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanManifestObject(item, context, `${path}[${index}]`, scene, visited),
    );
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'html') continue;
    if (key === 'url' && typeof (value as { html?: unknown }).html === 'string') continue;
    scanManifestObject(nested, context, `${path}.${key}`, scene, visited);
  }
}

function scanScene(
  rawScene: unknown,
  sceneIndex: number,
  context: ScanContext,
  visited: WeakSet<object>,
): void {
  if (!rawScene || typeof rawScene !== 'object') {
    addIssue(context, {
      code: 'invalid-manifest',
      severity: 'blocking',
      message: '课程场景格式无效',
      path: `scenes[${sceneIndex}]`,
    });
    return;
  }

  const sceneRecord = rawScene as ManifestScene;
  const scene: SceneContext = {
    sceneIndex,
    sceneTitle: typeof sceneRecord.title === 'string' ? sceneRecord.title : undefined,
  };
  const path = `scenes[${sceneIndex}]`;
  const content = sceneRecord.content;

  if (content?.type === 'interactive') {
    if (typeof content.html === 'string' && content.html.trim()) {
      scanInteractiveHtml(content.html, context, `${path}.content.html`, scene);
    } else if (typeof content.url === 'string' && isRemoteUrl(content.url)) {
      addIssue(
        context,
        {
          code: 'remote-interactive-page',
          severity: 'blocking',
          message: '互动场景由外部网页提供，断网后无法打开',
          path: `${path}.content.url`,
          url: content.url,
        },
        scene,
      );
    } else if (!content.html && !content.url) {
      addIssue(
        context,
        {
          code: 'empty-interactive-scene',
          severity: 'degraded',
          message: '互动场景没有可播放的内嵌页面',
          path: `${path}.content`,
        },
        scene,
      );
    }
  }

  scanManifestObject(sceneRecord, context, path, scene, visited);
}

function capabilityFromIssues(issues: OfflineAuditIssue[]): OfflineCapability {
  if (issues.some((issue) => issue.severity === 'blocking')) return 'requires-network';
  if (issues.length > 0) return 'basic';
  return 'fully';
}

/** Audit a parsed `.maic.zip` manifest without rendering or executing its HTML. */
export function auditCourseOfflineCapability(
  manifest: unknown,
  options: CourseOfflineAuditOptions = {},
): CourseOfflineAudit {
  const context = createScanContext(options);
  const visited = new WeakSet<object>();

  if (!manifest || typeof manifest !== 'object') {
    addIssue(context, {
      code: 'invalid-manifest',
      severity: 'blocking',
      message: '未找到可识别的课程清单',
      path: 'manifest',
    });
  } else {
    const candidate = manifest as Partial<ClassroomManifest>;
    if (!Array.isArray(candidate.scenes)) {
      addIssue(context, {
        code: 'invalid-manifest',
        severity: 'blocking',
        message: '课程清单缺少场景列表',
        path: 'manifest.scenes',
      });
    } else {
      candidate.scenes.forEach((scene, index) => scanScene(scene, index, context, visited));
    }

    for (const [assetPath, entry] of Object.entries(candidate.mediaIndex ?? {})) {
      if (entry?.missing) {
        addIssue(context, {
          code: 'missing-package-asset',
          severity: 'degraded',
          message: '课程包中有媒体文件缺失',
          path: `mediaIndex.${assetPath}`,
          url: assetPath,
        });
      }
    }

    const metadataOnly = { ...candidate, scenes: undefined, mediaIndex: undefined };
    scanManifestObject(metadataOnly, context, 'manifest', {}, visited);
  }

  const capability = capabilityFromIssues(context.issues);
  const externalOrigins = Array.from(
    new Set(context.issues.map((issue) => externalOrigin(issue.url)).filter(Boolean) as string[]),
  ).sort();
  const affectedScenes = new Set(
    context.issues
      .map((issue) => issue.sceneIndex)
      .filter((sceneIndex): sceneIndex is number => sceneIndex !== undefined),
  ).size;

  return {
    capability,
    ...CAPABILITY_COPY[capability],
    issues: context.issues,
    summary: {
      blocking: context.issues.filter((issue) => issue.severity === 'blocking').length,
      degraded: context.issues.filter((issue) => issue.severity === 'degraded').length,
      notice: context.issues.filter((issue) => issue.severity === 'notice').length,
      externalOrigins,
      affectedScenes,
    },
    auditedAt: new Date().toISOString(),
  };
}

export const auditOfflineCapability = auditCourseOfflineCapability;
