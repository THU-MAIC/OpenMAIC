import type { AppStage } from '@/lib/document-store';
import type { SceneType } from '@/lib/types/stage';

/** The lifecycle identity of a course inside the integrated workspace. */
export type CourseKind = 'original' | 'teacher_variant' | 'published';

/** The two top-level catalogue domains used by the workspace. */
export type CourseDomain = 'subject' | 'extracurricular';

/**
 * Whether every asset needed for teaching can be resolved without a network.
 * `partial` means the course opens locally but one or more optional/local assets
 * are missing; `network_required` means an explicit remote dependency remains.
 */
export type OfflineReadinessStatus = 'unchecked' | 'complete' | 'partial' | 'network_required';

export type CourseSourceKind =
  | 'created'
  | 'imported_zip'
  | 'imported_folder'
  | 'library'
  | 'legacy'
  | 'teacher_variant';

export interface CourseSourceInfo {
  kind: CourseSourceKind;
  sourceName?: string;
  sourceStageId?: string;
  sourceCourseId?: string;
  importJobId?: string;
  formatVersion?: number;
  importedAt?: number;
  sourceUrl?: string;
}

/**
 * Workspace-only metadata. The lesson document itself remains in the
 * DocumentStore, so the existing classroom/editor code keeps working unchanged.
 */
export interface CourseMetadataRecord {
  /** Primary key and foreign key to the DocumentStore stage id. */
  stageId: string;
  /** Mirrored from the document stage name; repository writes keep both values in sync. */
  title: string;
  /** Mirrored from `stages.description` when one is available. */
  summary?: string;
  kind: CourseKind;
  domain: CourseDomain;
  /** Secondary subject/category, e.g. physics or artificial intelligence. */
  subject?: string;
  category?: string;
  gradeBands: string[];
  tags: string[];
  source: CourseSourceInfo;
  teachingStyle?: string;
  offlineStatus: OfflineReadinessStatus;
  offlineIssueCount: number;
  offlineCheckedAt?: number;
  favorite: boolean;
  archived: boolean;
  author?: string;
  license?: string;
  estimatedMinutes?: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

/** Persisted lineage between a teacher's editable copy and its source course. */
export interface TeacherVariantRecord {
  /** Primary key and the cloned course's `stages.id`. */
  stageId: string;
  /** Immediate parent used to create this copy. */
  baseStageId: string;
  /** First non-variant ancestor, useful when variants are copied again. */
  rootStageId: string;
  label?: string;
  teachingStyle?: string;
  /** Source revision at copy time; later UI can use it for update warnings. */
  baseUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ImportSourceType = 'zip' | 'folder' | 'library' | 'backup';

export type ImportJobStatus =
  | 'queued'
  | 'parsing'
  | 'validating'
  | 'writing_media'
  | 'writing_course'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ImportJobIssue {
  code: string;
  message: string;
  path?: string;
}

/** Durable import history for ZIP, folder and future resource-library imports. */
export interface ImportJobRecord {
  id: string;
  sourceType: ImportSourceType;
  sourceName: string;
  sourceSize?: number;
  status: ImportJobStatus;
  progress: number;
  stageId?: string;
  detectedTitle?: string;
  formatVersion?: number;
  offlineStatus: OfflineReadinessStatus;
  warnings: ImportJobIssue[];
  error?: ImportJobIssue;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WorkspaceCourse {
  stage: AppStage;
  metadata: CourseMetadataRecord;
  sceneCount: number;
  sceneTypeCounts: Partial<Record<SceneType, number>>;
  teacherVariant?: TeacherVariantRecord;
}

export type OfflineIssueKind = 'missing_asset' | 'remote_dependency' | 'transient_asset';

export interface OfflineReadinessIssue {
  kind: OfflineIssueKind;
  code: string;
  message: string;
  sceneId?: string;
  reference?: string;
}

export interface OfflineReadinessReport {
  stageId: string;
  status: Exclude<OfflineReadinessStatus, 'unchecked'>;
  checkedAt: number;
  issues: OfflineReadinessIssue[];
  localAssetCount: number;
}

export interface ListWorkspaceCoursesOptions {
  search?: string;
  kind?: CourseKind | CourseKind[];
  domain?: CourseDomain;
  subject?: string;
  offlineStatus?: OfflineReadinessStatus;
  favorite?: boolean;
  includeArchived?: boolean;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc' | 'last_opened_desc';
  offset?: number;
  limit?: number;
}

export interface CourseMetadataPatch extends Partial<
  Omit<CourseMetadataRecord, 'stageId' | 'createdAt' | 'updatedAt' | 'source'>
> {
  source?: Partial<CourseSourceInfo>;
}

export interface CreateTeacherVariantOptions {
  stageId?: string;
  name?: string;
  description?: string;
  style?: string;
  label?: string;
  teachingStyle?: string;
  metadata?: CourseMetadataPatch;
}

export interface StartImportJobInput {
  sourceType: ImportSourceType;
  sourceName: string;
  sourceSize?: number;
  detectedTitle?: string;
  formatVersion?: number;
  status?: ImportJobStatus;
}

export type ImportJobPatch = Partial<
  Omit<ImportJobRecord, 'id' | 'sourceType' | 'sourceName' | 'createdAt' | 'updatedAt'>
>;

export interface ListImportJobsOptions {
  status?: ImportJobStatus | ImportJobStatus[];
  sourceType?: ImportSourceType;
  stageId?: string;
  limit?: number;
}

export interface WorkspaceStats {
  totalCourses: number;
  originalCourses: number;
  teacherVariants: number;
  publishedCourses: number;
  favorites: number;
  archived: number;
  offlineComplete: number;
  offlinePartial: number;
  networkRequired: number;
  offlineUnchecked: number;
  totalScenes: number;
  imports: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
  };
  locallyStoredAssetBytes: number;
}
