import type {
  ClassroomPackageInput,
  ClassroomPackageLimits,
  FolderPackageFile,
  PackageIssue,
  ResolvedClassroomPackageSource,
  ResolvedPackageEntry,
  VirtualPackageBody,
} from './types';
import { ClassroomPackageError } from './types';

interface MutableSourceEntry extends ResolvedPackageEntry {
  safePath: string;
}

interface ZipObjectMeta {
  compressedSize?: number;
  uncompressedSize?: number;
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ClassroomPackageError('aborted', '课程包读取已取消。');
  }
}

function safeNormalizedPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  const forward = rawPath.replace(/\\/g, '/');
  if (forward.startsWith('/') || /^[a-zA-Z]:\//.test(forward)) return null;

  const segments = forward.split('/');
  if (segments.some((part) => part === '..')) return null;
  const normalized = segments.filter((part) => part && part !== '.').join('/');
  return normalized || null;
}

function filePath(file: File): string {
  return file.webkitRelativePath || file.name;
}

async function virtualBodyToBlob(body: VirtualPackageBody): Promise<Blob> {
  const value = typeof body === 'function' ? await body() : body;
  if (value instanceof Blob) return value;
  if (typeof value === 'string') return new Blob([value], { type: 'text/plain' });
  if (value instanceof ArrayBuffer) return new Blob([value]);
  // Copy into an ArrayBuffer-backed view. A Uint8Array may otherwise carry a
  // SharedArrayBuffer under TS's newer generic typed-array definitions, which
  // BlobPart deliberately rejects.
  return new Blob([new Uint8Array(value).buffer]);
}

function resolvePackageRoot(rawEntries: MutableSourceEntry[]): {
  entries: Map<string, ResolvedPackageEntry>;
  manifestPath: string;
  outsideCount: number;
} {
  const directManifest = rawEntries.find((entry) => entry.safePath === 'manifest.json');
  const manifestCandidates = directManifest
    ? [directManifest]
    : rawEntries.filter((entry) => entry.safePath.endsWith('/manifest.json'));

  if (manifestCandidates.length === 0) {
    throw new ClassroomPackageError(
      'missing-manifest',
      '没有找到 manifest.json，这不是可识别的 OpenMAIC 课程包。',
    );
  }
  if (manifestCandidates.length > 1) {
    throw new ClassroomPackageError(
      'ambiguous-manifest',
      '课程包中发现多个 manifest.json，无法判断课程根目录。',
    );
  }

  const manifest = manifestCandidates[0];
  const rootPrefix = manifest.safePath.slice(0, -'manifest.json'.length);
  const entries = new Map<string, ResolvedPackageEntry>();
  const caseInsensitivePaths = new Set<string>();
  let outsideCount = 0;

  for (const rawEntry of rawEntries) {
    if (!rawEntry.safePath.startsWith(rootPrefix)) {
      // Finder metadata is harmless and routinely appears outside a wrapped folder.
      if (!rawEntry.safePath.startsWith('__MACOSX/')) outsideCount += 1;
      continue;
    }
    const relativePath = rawEntry.safePath.slice(rootPrefix.length);
    if (!relativePath) continue;
    const pathKey = relativePath.toLocaleLowerCase('en-US');
    if (caseInsensitivePaths.has(pathKey)) {
      throw new ClassroomPackageError('unsafe-package', `课程包包含重复路径：${relativePath}`);
    }
    caseInsensitivePaths.add(pathKey);
    entries.set(relativePath, { ...rawEntry, path: relativePath });
  }

  return { entries, manifestPath: manifest.safePath, outsideCount };
}

function validateSourceLimits(
  entries: Iterable<ResolvedPackageEntry>,
  compressedBytes: number,
  limits: ClassroomPackageLimits,
): PackageIssue[] {
  const issues: PackageIssue[] = [];
  const list = [...entries];
  const uncompressedBytes = list.reduce((total, entry) => total + entry.size, 0);

  if (list.length > limits.maxFiles) {
    issues.push({
      code: 'too-many-files',
      severity: 'error',
      message: `文件数量 ${list.length.toLocaleString()} 超过安全上限 ${limits.maxFiles.toLocaleString()}。`,
    });
  }
  if (compressedBytes > limits.maxCompressedBytes) {
    issues.push({
      code: 'compressed-size-limit',
      severity: 'error',
      message: '压缩包体积超过安全上限。',
    });
  }
  if (uncompressedBytes > limits.maxUncompressedBytes) {
    issues.push({
      code: 'uncompressed-size-limit',
      severity: 'error',
      message: '课程包解压后的预计体积超过安全上限。',
    });
  }
  for (const entry of list) {
    if (entry.size > limits.maxEntryBytes) {
      issues.push({
        code: 'entry-size-limit',
        severity: 'error',
        message: `单个文件超过安全上限：${entry.path}`,
        path: entry.path,
      });
    }
    if (
      entry.compressedSize !== undefined &&
      entry.compressedSize > 0 &&
      entry.size / entry.compressedSize > limits.maxCompressionRatio
    ) {
      issues.push({
        code: 'compression-ratio-limit',
        severity: 'error',
        message: `文件压缩比异常：${entry.path}`,
        path: entry.path,
      });
    }
  }
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > limits.maxCompressionRatio) {
    issues.push({
      code: 'compression-ratio-limit',
      severity: 'error',
      message: '课程包整体压缩比异常，已阻止导入。',
    });
  }
  return issues;
}

async function resolveZip(
  file: File,
  limits: ClassroomPackageLimits,
  signal?: AbortSignal,
): Promise<{ source: ResolvedClassroomPackageSource; issues: PackageIssue[] }> {
  if (!file.name.toLocaleLowerCase('en-US').endsWith('.maic.zip')) {
    throw new ClassroomPackageError(
      'invalid-extension',
      '请选择以 .maic.zip 结尾的 OpenMAIC 课程包。',
    );
  }
  if (file.size > limits.maxCompressedBytes) {
    throw new ClassroomPackageError('limits-exceeded', '压缩包体积超过安全上限。');
  }
  abortIfNeeded(signal);

  let zip: import('jszip');
  try {
    const JSZip = (await import('jszip')).default;
    zip = await JSZip.loadAsync(file, { checkCRC32: false });
  } catch (error) {
    throw new ClassroomPackageError('invalid-zip', '无法读取这个 ZIP 文件。', error);
  }
  abortIfNeeded(signal);

  const rawEntries: MutableSourceEntry[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const originalPath = entry.unsafeOriginalName || entry.name;
    const safePath = safeNormalizedPath(originalPath);
    if (!safePath) {
      throw new ClassroomPackageError(
        'unsafe-package',
        `课程包包含不安全的文件路径：${originalPath}`,
      );
    }
    const zipMeta = (entry as typeof entry & { _data?: ZipObjectMeta })._data;
    const size = zipMeta?.uncompressedSize ?? 0;
    const compressedSize = zipMeta?.compressedSize;
    rawEntries.push({
      path: safePath,
      safePath,
      originalPath,
      size,
      compressedSize,
      readBlob: () => entry.async('blob'),
      readText: () => entry.async('text'),
    });
  }

  const rooted = resolvePackageRoot(rawEntries);
  const uncompressedBytes = [...rooted.entries.values()].reduce(
    (total, entry) => total + entry.size,
    0,
  );
  const issues = validateSourceLimits(rooted.entries.values(), file.size, limits);
  if (rooted.outsideCount > 0) {
    issues.push({
      code: 'unscoped-files',
      severity: 'warning',
      message: `课程根目录外还有 ${rooted.outsideCount} 个文件，导入时会忽略。`,
    });
  }

  return {
    source: {
      kind: 'zip',
      name: file.name,
      manifestPath: rooted.manifestPath,
      entries: rooted.entries,
      compressedBytes: file.size,
      uncompressedBytes,
    },
    issues,
  };
}

function resolveFolder(
  files: readonly (File | FolderPackageFile)[],
  name: string | undefined,
  limits: ClassroomPackageLimits,
): { source: ResolvedClassroomPackageSource; issues: PackageIssue[] } {
  if (files.length === 0) {
    throw new ClassroomPackageError('invalid-input', '选择的文件夹是空的。');
  }
  const rawEntries: MutableSourceEntry[] = files.map((value) => {
    const wrapped = 'file' in value && 'path' in value;
    const file = wrapped ? value.file : value;
    const originalPath = wrapped ? value.path : filePath(file);
    const safePath = safeNormalizedPath(originalPath);
    if (!safePath) {
      throw new ClassroomPackageError('unsafe-package', `文件夹包含不安全的路径：${originalPath}`);
    }
    return {
      path: safePath,
      safePath,
      originalPath,
      size: file.size,
      compressedSize: file.size,
      readBlob: async () => file,
      readText: () => file.text(),
    };
  });
  const rooted = resolvePackageRoot(rawEntries);
  const uncompressedBytes = [...rooted.entries.values()].reduce(
    (total, entry) => total + entry.size,
    0,
  );
  const issues = validateSourceLimits(rooted.entries.values(), uncompressedBytes, limits);
  if (rooted.outsideCount > 0) {
    issues.push({
      code: 'unscoped-files',
      severity: 'warning',
      message: `课程根目录外还有 ${rooted.outsideCount} 个文件，导入时会忽略。`,
    });
  }
  return {
    source: {
      kind: 'folder',
      name: name || rooted.manifestPath.split('/')[0] || '课程文件夹',
      manifestPath: rooted.manifestPath,
      entries: rooted.entries,
      compressedBytes: uncompressedBytes,
      uncompressedBytes,
    },
    issues,
  };
}

function resolveVirtual(
  input: Extract<ClassroomPackageInput, { kind: 'virtual' }>,
  limits: ClassroomPackageLimits,
): { source: ResolvedClassroomPackageSource; issues: PackageIssue[] } {
  const rawEntries: MutableSourceEntry[] = input.files.map((virtualFile) => {
    const safePath = safeNormalizedPath(virtualFile.path);
    if (!safePath) {
      throw new ClassroomPackageError(
        'unsafe-package',
        `虚拟课程包包含不安全的路径：${virtualFile.path}`,
      );
    }
    const immediateBody = typeof virtualFile.body === 'function' ? undefined : virtualFile.body;
    const inferredSize =
      immediateBody instanceof Blob
        ? immediateBody.size
        : typeof immediateBody === 'string'
          ? new TextEncoder().encode(immediateBody).byteLength
          : immediateBody instanceof ArrayBuffer
            ? immediateBody.byteLength
            : immediateBody?.byteLength;
    const size = virtualFile.size ?? inferredSize ?? 0;
    return {
      path: safePath,
      safePath,
      originalPath: virtualFile.path,
      size,
      compressedSize: virtualFile.compressedSize,
      readBlob: async () => virtualBodyToBlob(virtualFile.body),
      readText: async () => (await virtualBodyToBlob(virtualFile.body)).text(),
    };
  });
  const rooted = resolvePackageRoot(rawEntries);
  const uncompressedBytes = [...rooted.entries.values()].reduce(
    (total, entry) => total + entry.size,
    0,
  );
  const compressedBytes = input.compressedSize ?? uncompressedBytes;
  const issues = validateSourceLimits(rooted.entries.values(), compressedBytes, limits);
  return {
    source: {
      kind: 'virtual',
      name: input.name,
      manifestPath: rooted.manifestPath,
      entries: rooted.entries,
      compressedBytes,
      uncompressedBytes,
    },
    issues,
  };
}

function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File;
}

function isFileArray(value: ClassroomPackageInput): value is readonly File[] {
  return Array.isArray(value);
}

export async function resolveClassroomPackageSource(
  input: ClassroomPackageInput,
  limits: ClassroomPackageLimits,
  signal?: AbortSignal,
): Promise<{ source: ResolvedClassroomPackageSource; issues: PackageIssue[] }> {
  abortIfNeeded(signal);
  if (isFile(input)) return resolveZip(input, limits, signal);
  if (isFileArray(input)) return resolveFolder(input, undefined, limits);
  if (input.kind === 'zip') return resolveZip(input.file, limits, signal);
  if (input.kind === 'folder') return resolveFolder(input.files, input.name, limits);
  if (input.kind === 'virtual') return resolveVirtual(input, limits);
  throw new ClassroomPackageError('invalid-input', '不支持的课程包输入。');
}
