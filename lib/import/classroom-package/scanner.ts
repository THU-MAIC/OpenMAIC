import { nanoid } from 'nanoid';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  type ClassroomManifest,
} from '@/lib/export/classroom-zip-types';
import {
  CLASSROOM_PACKAGE_LIMITS,
  ClassroomPackageError,
  type ClassroomPackageInput,
  type ClassroomPackageLimits,
  type ClassroomPackagePreview,
  type ClassroomPackageScan,
  type ExternalPackageResource,
  type MissingPackageResource,
  type PackageIssue,
  type ScanClassroomPackageOptions,
} from './types';
import { resolveClassroomPackageSource } from './source';
import {
  buildMediaElementIdMap,
  collectGeneratedMediaReferences,
  normalizedMediaPath,
} from './media-refs';

const HTTP_URL = /https?:\/\/[^\s"'<>\\)\]]+/g;

const NON_FETCHING_NAMESPACE_URLS = new Set([
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/XML/1998/namespace',
]);

function isNonFetchingNamespaceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return NON_FETCHING_NAMESPACE_URLS.has(`${url.origin}${url.pathname}`);
  } catch {
    return false;
  }
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ClassroomPackageError('aborted', '课程包扫描已取消。');
  }
}

function progress(
  options: ScanClassroomPackageOptions,
  phase: 'opening' | 'indexing' | 'validating' | 'ready',
  value: number,
  message: string,
) {
  options.onProgress?.({ phase, progress: value, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);
const MEDIA_TYPES = new Set(['audio', 'image', 'generated']);

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && record[key].trim().length > 0;
}

function invalidManifest(message: string): never {
  throw new ClassroomPackageError('invalid-manifest', `manifest.json ${message}`);
}

function validateAgent(value: unknown, index: number): void {
  if (!isRecord(value)) invalidManifest(`中的 agents[${index}] 不是有效对象。`);
  for (const field of ['name', 'role', 'persona', 'avatar', 'color']) {
    if (!hasString(value, field)) {
      invalidManifest(`中的 agents[${index}].${field} 缺少必需字符串。`);
    }
  }
  if (typeof value.priority !== 'number' || !Number.isFinite(value.priority)) {
    invalidManifest(`中的 agents[${index}].priority 不是有效数字。`);
  }
}

function validateSceneContent(value: unknown, sceneType: string, index: number): void {
  if (!isRecord(value) || !hasString(value, 'type')) {
    invalidManifest(`中的 scenes[${index}].content 不是有效内容对象。`);
  }
  if (!SCENE_TYPES.has(value.type as string) || value.type !== sceneType) {
    invalidManifest(`中的 scenes[${index}] 类型与 content.type 不合法或不一致。`);
  }
  if (sceneType === 'slide' && !isRecord(value.canvas)) {
    invalidManifest(`中的 scenes[${index}].content.canvas 不是有效对象。`);
  }
  if (sceneType === 'quiz' && !Array.isArray(value.questions)) {
    invalidManifest(`中的 scenes[${index}].content.questions 不是数组。`);
  }
  if (sceneType === 'interactive' && typeof value.url !== 'string') {
    invalidManifest(`中的 scenes[${index}].content.url 不是字符串。`);
  }
  if (sceneType === 'pbl' && !isRecord(value.projectConfig)) {
    invalidManifest(`中的 scenes[${index}].content.projectConfig 不是有效对象。`);
  }
}

function validateScene(value: unknown, index: number): void {
  if (!isRecord(value) || !hasString(value, 'type') || !SCENE_TYPES.has(value.type as string)) {
    invalidManifest(`中的 scenes[${index}].type 不合法。`);
  }
  validateSceneContent(value.content, value.type as string, index);
  if ('actions' in value && value.actions !== undefined && !Array.isArray(value.actions)) {
    invalidManifest(`中的 scenes[${index}].actions 不是数组。`);
  }
  if (Array.isArray(value.actions)) {
    value.actions.forEach((action, actionIndex) => {
      if (!isRecord(action) || !hasString(action, 'type')) {
        invalidManifest(`中的 scenes[${index}].actions[${actionIndex}] 不是有效动作。`);
      }
    });
  }
  if (
    'whiteboards' in value &&
    value.whiteboards !== undefined &&
    !Array.isArray(value.whiteboards)
  ) {
    invalidManifest(`中的 scenes[${index}].whiteboards 不是数组。`);
  }
}

function validateMediaIndex(value: unknown): void {
  if (!isRecord(value)) invalidManifest('中的 mediaIndex 不是资源索引对象。');
  for (const [path, media] of Object.entries(value)) {
    if (!isRecord(media) || !hasString(media, 'type') || !MEDIA_TYPES.has(media.type as string)) {
      invalidManifest(`中的 mediaIndex[${JSON.stringify(path)}] 不是有效资源记录。`);
    }
    if ('mimeType' in media && media.mimeType !== undefined && typeof media.mimeType !== 'string') {
      invalidManifest(`中的 mediaIndex[${JSON.stringify(path)}].mimeType 不是字符串。`);
    }
    if ('missing' in media && media.missing !== undefined && typeof media.missing !== 'boolean') {
      invalidManifest(`中的 mediaIndex[${JSON.stringify(path)}].missing 不是布尔值。`);
    }
  }
}

function normalizeManifest(value: unknown): ClassroomManifest {
  if (!isRecord(value) || !isRecord(value.stage) || !Array.isArray(value.scenes)) {
    throw new ClassroomPackageError(
      'invalid-manifest',
      'manifest.json 缺少 stage 或 scenes 数据。',
    );
  }

  if ('agents' in value && value.agents !== undefined && !Array.isArray(value.agents)) {
    invalidManifest('中的 agents 不是数组。');
  }
  const agents = Array.isArray(value.agents) ? value.agents : [];
  agents.forEach(validateAgent);
  value.scenes.forEach(validateScene);
  if ('mediaIndex' in value && value.mediaIndex !== undefined) validateMediaIndex(value.mediaIndex);

  const stage = value.stage;
  const now = Date.now();
  return {
    formatVersion:
      typeof value.formatVersion === 'number' && Number.isInteger(value.formatVersion)
        ? value.formatVersion
        : CLASSROOM_ZIP_FORMAT_VERSION,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : 'legacy',
    stage: {
      name: typeof stage.name === 'string' && stage.name.trim() ? stage.name.trim() : '导入的课程',
      description: typeof stage.description === 'string' ? stage.description : undefined,
      language: typeof stage.language === 'string' ? stage.language : undefined,
      style: typeof stage.style === 'string' ? stage.style : undefined,
      createdAt: typeof stage.createdAt === 'number' ? stage.createdAt : now,
      updatedAt: typeof stage.updatedAt === 'number' ? stage.updatedAt : now,
    },
    agents: agents as ClassroomManifest['agents'],
    scenes: value.scenes as ClassroomManifest['scenes'],
    mediaIndex: isRecord(value.mediaIndex)
      ? (value.mediaIndex as ClassroomManifest['mediaIndex'])
      : {},
  };
}

function collectExternalResources(manifest: ClassroomManifest): ExternalPackageResource[] {
  const found = new Map<string, ExternalPackageResource>();

  const visit = (value: unknown, path: string, requiredContext = false) => {
    if (typeof value === 'string') {
      const matches = value.match(HTTP_URL) ?? [];
      for (const url of matches) {
        // SVG/XML namespace identifiers are URIs, not resources the browser
        // fetches. They must not downgrade an otherwise offline-ready course.
        if (isNonFetchingNamespaceUrl(url)) continue;
        let normalizedUrl = url;
        try {
          normalizedUrl = new URL(url).toString();
        } catch {
          // Preserve the discovered value in the report when URL parsing is stricter.
        }
        const requiredForPlayback =
          requiredContext ||
          /\.audioUrl$/i.test(path) ||
          (/\.content\.html$/i.test(path) &&
            /<(script|link|img|video|audio|source|iframe)\b/i.test(value));
        const key = `${normalizedUrl}\0${path}`;
        found.set(key, { url: normalizedUrl, referencedBy: path, requiredForPlayback });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, requiredContext));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const isBareInteractiveUrl =
        key === 'url' &&
        value.type === 'interactive' &&
        (typeof value.html !== 'string' || value.html.trim().length === 0);
      visit(child, childPath, requiredContext || isBareInteractiveUrl);
    }
  };

  visit(manifest, 'manifest');
  return [...found.values()];
}

function collectMissingResources(
  manifest: ClassroomManifest,
  entryPaths: ReadonlySet<string>,
): MissingPackageResource[] {
  const missing = new Map<string, MissingPackageResource>();
  const mediaPaths = new Set<string>();

  for (const [rawPath, media] of Object.entries(manifest.mediaIndex ?? {})) {
    const path = normalizedMediaPath(rawPath);
    if (!path) {
      missing.set(rawPath, { path: rawPath, reason: 'not-in-package' });
      continue;
    }
    mediaPaths.add(path);
    if (media.missing) {
      missing.set(path, { path, reason: 'declared-missing' });
    } else if (!entryPaths.has(path)) {
      missing.set(path, { path, reason: 'not-in-package' });
    }
  }

  manifest.scenes.forEach((scene, sceneIndex) => {
    scene.actions?.forEach((action, actionIndex) => {
      if (action.type !== 'speech' || !('audioRef' in action) || !action.audioRef) return;
      const path = normalizedMediaPath(action.audioRef);
      const referencedBy = `scenes[${sceneIndex}].actions[${actionIndex}]`;
      if (!path || !mediaPaths.has(path)) {
        const key = path || action.audioRef;
        missing.set(key, { path: key, reason: 'unindexed-reference', referencedBy });
      } else if (!entryPaths.has(path)) {
        missing.set(path, { path, reason: 'not-in-package', referencedBy });
      }
    });
  });

  const mediaElementIds = buildMediaElementIdMap(
    Object.entries(manifest.mediaIndex)
      .filter(([, media]) => media.type === 'image' || media.type === 'generated')
      .map(([path]) => path),
  );
  const pathByElementId = new Map<string, string>();
  for (const [rawPath, elementId] of mediaElementIds) pathByElementId.set(elementId, rawPath);

  manifest.scenes.forEach((scene, sceneIndex) => {
    for (const reference of collectGeneratedMediaReferences(
      scene.content,
      `scenes[${sceneIndex}].content`,
    )) {
      const rawPath = pathByElementId.get(reference.elementId);
      if (!rawPath) {
        missing.set(reference.elementId, {
          path: reference.elementId,
          reason: 'unindexed-reference',
          referencedBy: reference.referencedBy,
        });
        continue;
      }
      const path = normalizedMediaPath(rawPath);
      const media = manifest.mediaIndex[rawPath];
      if (!path || media.missing || !entryPaths.has(path)) {
        missing.set(path || rawPath, {
          path: path || rawPath,
          reason: media.missing ? 'declared-missing' : 'not-in-package',
          referencedBy: reference.referencedBy,
        });
      }
    }
  });

  return [...missing.values()];
}

function summarizeMedia(manifest: ClassroomManifest) {
  const mediaTypes = { audio: 0, image: 0, video: 0, other: 0 };
  for (const media of Object.values(manifest.mediaIndex ?? {})) {
    if (media.type === 'audio') mediaTypes.audio += 1;
    else if (media.mimeType?.startsWith('video/')) mediaTypes.video += 1;
    else if (media.type === 'image' || media.mimeType?.startsWith('image/')) mediaTypes.image += 1;
    else mediaTypes.other += 1;
  }
  return mediaTypes;
}

function validateManifest(manifest: ClassroomManifest): PackageIssue[] {
  const issues: PackageIssue[] = [];
  if (manifest.formatVersion > CLASSROOM_ZIP_FORMAT_VERSION) {
    issues.push({
      code: 'unsupported-format',
      severity: 'error',
      message: `课程包格式 v${manifest.formatVersion} 高于当前支持的 v${CLASSROOM_ZIP_FORMAT_VERSION}。`,
    });
  } else if (manifest.formatVersion < CLASSROOM_ZIP_FORMAT_VERSION) {
    issues.push({
      code: 'legacy-format',
      severity: 'warning',
      message: `这是旧版课程包（v${manifest.formatVersion}），将按兼容模式导入。`,
    });
  }

  manifest.scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== 'object' || !scene.content || !scene.type) {
      issues.push({
        code: 'invalid-scene',
        severity: 'error',
        message: `第 ${index + 1} 个场景缺少类型或内容。`,
      });
    }
  });
  return issues;
}

export async function scanClassroomPackage(
  input: ClassroomPackageInput,
  options: ScanClassroomPackageOptions = {},
): Promise<ClassroomPackageScan> {
  const limits: ClassroomPackageLimits = { ...CLASSROOM_PACKAGE_LIMITS, ...options.limits };
  abortIfNeeded(options.signal);
  progress(options, 'opening', 5, '正在打开课程包…');
  const resolved = await resolveClassroomPackageSource(input, limits, options.signal);
  abortIfNeeded(options.signal);

  progress(options, 'indexing', 35, '正在检查文件结构与安全限制…');
  const manifestEntry = resolved.source.entries.get('manifest.json');
  if (!manifestEntry) {
    throw new ClassroomPackageError('missing-manifest', '没有找到课程包清单。');
  }
  if (manifestEntry.size > limits.maxManifestBytes) {
    throw new ClassroomPackageError('limits-exceeded', 'manifest.json 体积超过安全上限。');
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await manifestEntry.readText());
  } catch (error) {
    throw new ClassroomPackageError('invalid-manifest', 'manifest.json 不是有效的 JSON。', error);
  }
  abortIfNeeded(options.signal);
  const manifest = normalizeManifest(rawManifest);

  progress(options, 'validating', 70, '正在生成课程与离线可用性报告…');
  const entryPaths = new Set(resolved.source.entries.keys());
  const missingResources = collectMissingResources(manifest, entryPaths);
  const externalResources = collectExternalResources(manifest);
  const issues = [...resolved.issues, ...validateManifest(manifest)];
  if (missingResources.length > 0) {
    issues.push({
      code: 'missing-resource',
      severity: 'warning',
      message: `发现 ${missingResources.length} 个缺失或未打包的资源。`,
    });
  }
  if (externalResources.length > 0) {
    issues.push({
      code: 'external-resource',
      severity: 'warning',
      message: `发现 ${externalResources.length} 个外部网络资源。`,
    });
  }

  const sceneTypes: Record<string, number> = {};
  for (const scene of manifest.scenes) {
    const type = typeof scene?.type === 'string' ? scene.type : 'unknown';
    sceneTypes[type] = (sceneTypes[type] ?? 0) + 1;
  }
  const mediaTypes = summarizeMedia(manifest);
  const requiredExternal = externalResources.some((resource) => resource.requiredForPlayback);
  const offlineLevel = requiredExternal
    ? 'network-required'
    : missingResources.length > 0 || externalResources.length > 0
      ? 'partial'
      : 'complete';
  const preview: ClassroomPackagePreview = {
    packageName: resolved.source.name,
    sourceKind: resolved.source.kind,
    title: manifest.stage.name,
    description: manifest.stage.description,
    formatVersion: manifest.formatVersion,
    appVersion: manifest.appVersion,
    exportedAt: manifest.exportedAt,
    sceneCount: manifest.scenes.length,
    sceneTypes,
    agentCount: manifest.agents.length,
    mediaCount: Object.keys(manifest.mediaIndex ?? {}).length,
    mediaTypes,
    fileCount: resolved.source.entries.size,
    compressedBytes: resolved.source.compressedBytes,
    uncompressedBytes: resolved.source.uncompressedBytes,
    missingResources,
    externalResources,
    offlineLevel,
    issues,
    canImport: !issues.some((issue) => issue.severity === 'error'),
  };

  progress(options, 'ready', 100, '课程包预检完成');
  return { id: nanoid(), manifest, preview, source: resolved.source, limits };
}
