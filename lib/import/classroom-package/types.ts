import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

export const CLASSROOM_PACKAGE_LIMITS = {
  maxFiles: 2_000,
  maxCompressedBytes: 200 * 1024 * 1024,
  maxUncompressedBytes: 400 * 1024 * 1024,
  maxEntryBytes: 200 * 1024 * 1024,
  maxManifestBytes: 5 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const;

export interface ClassroomPackageLimits {
  maxFiles: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  maxManifestBytes: number;
  maxCompressionRatio: number;
}

export interface FolderPackageFile {
  file: File;
  /** Path relative to the folder that was selected or dropped. */
  path: string;
}

export interface FolderClassroomPackageInput {
  kind: 'folder';
  name?: string;
  files: readonly (File | FolderPackageFile)[];
}

export interface ZipClassroomPackageInput {
  kind: 'zip';
  file: File;
}

export type VirtualPackageBody =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | string
  | (() => Promise<Blob | ArrayBuffer | Uint8Array | string>);

export interface VirtualPackageFile {
  path: string;
  body: VirtualPackageBody;
  /** Optional hint used to reject oversized packages before reading a body. */
  size?: number;
  compressedSize?: number;
}

export interface VirtualClassroomPackageInput {
  kind: 'virtual';
  name: string;
  files: readonly VirtualPackageFile[];
  compressedSize?: number;
}

export type ClassroomPackageInput =
  | File
  | readonly File[]
  | ZipClassroomPackageInput
  | FolderClassroomPackageInput
  | VirtualClassroomPackageInput;

export type PackageSourceKind = 'zip' | 'folder' | 'virtual';
export type OfflineLevel = 'complete' | 'partial' | 'network-required';
export type PackageIssueSeverity = 'warning' | 'error';

export interface PackageIssue {
  code:
    | 'legacy-format'
    | 'unsupported-format'
    | 'unsafe-path'
    | 'duplicate-path'
    | 'too-many-files'
    | 'compressed-size-limit'
    | 'uncompressed-size-limit'
    | 'entry-size-limit'
    | 'compression-ratio-limit'
    | 'invalid-scene'
    | 'missing-resource'
    | 'external-resource'
    | 'unscoped-files';
  severity: PackageIssueSeverity;
  message: string;
  path?: string;
}

export interface MissingPackageResource {
  path: string;
  reason: 'declared-missing' | 'not-in-package' | 'unindexed-reference';
  referencedBy?: string;
}

export interface ExternalPackageResource {
  url: string;
  referencedBy: string;
  requiredForPlayback: boolean;
}

export interface ClassroomPackagePreview {
  packageName: string;
  sourceKind: PackageSourceKind;
  title: string;
  description?: string;
  formatVersion: number;
  appVersion?: string;
  exportedAt?: string;
  sceneCount: number;
  sceneTypes: Record<string, number>;
  agentCount: number;
  mediaCount: number;
  mediaTypes: {
    audio: number;
    image: number;
    video: number;
    other: number;
  };
  fileCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  missingResources: MissingPackageResource[];
  externalResources: ExternalPackageResource[];
  offlineLevel: OfflineLevel;
  issues: PackageIssue[];
  canImport: boolean;
}

export interface ResolvedPackageEntry {
  /** Normalized path relative to the package manifest. */
  path: string;
  originalPath: string;
  size: number;
  compressedSize?: number;
  readBlob: () => Promise<Blob>;
  readText: () => Promise<string>;
}

export interface ResolvedClassroomPackageSource {
  kind: PackageSourceKind;
  name: string;
  manifestPath: string;
  entries: ReadonlyMap<string, ResolvedPackageEntry>;
  compressedBytes: number;
  uncompressedBytes: number;
}

/** Result of a preflight scan. Keep this object to commit the exact bytes that were checked. */
export interface ClassroomPackageScan {
  id: string;
  manifest: ClassroomManifest;
  preview: ClassroomPackagePreview;
  source: ResolvedClassroomPackageSource;
  limits: ClassroomPackageLimits;
}

export type ScanPhase = 'opening' | 'indexing' | 'validating' | 'ready';
export type ImportCommitPhase = 'preparing' | 'writing' | 'done';
export type ClassroomPackageProgressPhase = ScanPhase | ImportCommitPhase;

export interface ClassroomPackageProgress {
  phase: ClassroomPackageProgressPhase;
  progress: number;
  message: string;
}

export interface ScanClassroomPackageOptions {
  limits?: Partial<ClassroomPackageLimits>;
  signal?: AbortSignal;
  onProgress?: (update: ClassroomPackageProgress) => void;
}

export interface ImportClassroomPackageOptions {
  signal?: AbortSignal;
  onProgress?: (update: ClassroomPackageProgress) => void;
}

export interface ImportedClassroomPackage {
  importJobId: string;
  stageId: string;
  title: string;
  sceneCount: number;
  mediaCount: number;
  audioCount: number;
}

export type ClassroomPackageErrorCode =
  | 'aborted'
  | 'invalid-input'
  | 'invalid-extension'
  | 'invalid-zip'
  | 'missing-manifest'
  | 'ambiguous-manifest'
  | 'invalid-manifest'
  | 'unsafe-package'
  | 'limits-exceeded'
  | 'unsupported-format'
  | 'storage-full'
  | 'import-failed';

export class ClassroomPackageError extends Error {
  constructor(
    public readonly code: ClassroomPackageErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClassroomPackageError';
  }
}
