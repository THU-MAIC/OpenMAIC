import { nanoid } from 'nanoid';
import {
  accessDocument,
  getDocumentStore,
  getLegacyDocumentStore,
  mutateDocument,
  type AppDocument,
  type AppStage,
} from '@/lib/document-store';
import type { Scene, SceneType } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import type {
  CourseMetadataPatch,
  CourseMetadataRecord,
  CreateTeacherVariantOptions,
  ImportJobIssue,
  ImportJobPatch,
  ImportJobRecord,
  ImportJobStatus,
  ListImportJobsOptions,
  ListWorkspaceCoursesOptions,
  StartImportJobInput,
  TeacherVariantRecord,
  WorkspaceCourse,
  WorkspaceStats,
} from './types';

const IMPORT_IN_PROGRESS = new Set<ImportJobStatus>([
  'queued',
  'parsing',
  'validating',
  'writing_media',
  'writing_course',
]);

function defaultCourseMetadata(
  stage: AppStage,
  variant?: TeacherVariantRecord,
): CourseMetadataRecord {
  return {
    stageId: stage.id,
    title: stage.name || 'Untitled Course',
    summary: stage.description,
    kind: variant ? 'teacher_variant' : 'original',
    domain: 'subject',
    gradeBands: [],
    tags: [],
    source: variant
      ? {
          kind: 'teacher_variant',
          sourceStageId: variant.baseStageId,
          sourceCourseId: variant.rootStageId,
        }
      : { kind: 'legacy' },
    offlineStatus: 'unchecked',
    offlineIssueCount: 0,
    favorite: false,
    archived: false,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  };
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function rewriteReferences<T>(value: T, replacements: ReadonlyMap<string, string>): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return replacements.get(current) ?? current;
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== 'object') return current;
    if (current instanceof Blob || current instanceof ArrayBuffer) return current;

    const rewritten: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      rewritten[key] = visit(item);
    }
    return rewritten;
  };

  return visit(value) as T;
}

function sceneTypeCounts(scenes: Scene[]): Partial<Record<SceneType, number>> {
  const counts: Partial<Record<SceneType, number>> = {};
  for (const scene of scenes) counts[scene.type] = (counts[scene.type] ?? 0) + 1;
  return counts;
}

function toWorkspaceCourse(
  document: AppDocument,
  metadata: CourseMetadataRecord,
  teacherVariant?: TeacherVariantRecord,
): WorkspaceCourse {
  return {
    stage: document.stage,
    metadata,
    sceneCount: document.scenes.length,
    sceneTypeCounts: sceneTypeCounts(document.scenes),
    teacherVariant,
  };
}

async function loadWorkspaceDocuments(): Promise<AppDocument[]> {
  const store = getDocumentStore();
  const [summaries, legacyStages] = await Promise.all([
    store.listDocuments(),
    getLegacyDocumentStore().listStages(),
  ]);
  const stageIds = [
    ...new Set([...summaries.map(({ id }) => id), ...legacyStages.map(({ id }) => id)]),
  ];
  const settled = await Promise.allSettled(
    stageIds.map(async (id) => (await accessDocument(id)).document),
  );
  return settled.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  );
}

export function ensureWorkspaceMetadata(): Promise<CourseMetadataRecord[]>;
export function ensureWorkspaceMetadata(stageId: string): Promise<CourseMetadataRecord | undefined>;
export async function ensureWorkspaceMetadata(
  stageId?: string,
): Promise<CourseMetadataRecord[] | CourseMetadataRecord | undefined> {
  const documents = stageId
    ? [(await accessDocument(stageId)).document].filter(
        (document): document is AppDocument => document !== null,
      )
    : await loadWorkspaceDocuments();

  const records = await db.transaction('rw', [db.courseMetadata, db.teacherVariants], async () => {
    const ensured: CourseMetadataRecord[] = [];
    for (const { stage } of documents) {
      const [existing, variant] = await Promise.all([
        db.courseMetadata.get(stage.id),
        db.teacherVariants.get(stage.id),
      ]);
      if (!existing) {
        const created = defaultCourseMetadata(stage, variant);
        await db.courseMetadata.add(created);
        ensured.push(created);
        continue;
      }

      const title = stage.name || 'Untitled Course';
      const kind = variant ? 'teacher_variant' : existing.kind;
      const source = variant
        ? {
            ...existing.source,
            kind: 'teacher_variant' as const,
            sourceStageId: variant.baseStageId,
            sourceCourseId: variant.rootStageId,
          }
        : existing.source;
      const changed =
        existing.title !== title ||
        existing.summary !== stage.description ||
        existing.kind !== kind ||
        source.kind !== existing.source.kind ||
        source.sourceStageId !== existing.source.sourceStageId ||
        source.sourceCourseId !== existing.source.sourceCourseId;
      const next: CourseMetadataRecord = changed
        ? {
            ...existing,
            title,
            summary: stage.description,
            kind,
            source,
            updatedAt: Math.max(existing.updatedAt, stage.updatedAt),
          }
        : existing;
      if (changed) await db.courseMetadata.put(next);
      ensured.push(next);
    }
    return ensured;
  });

  return stageId ? records[0] : records;
}

export async function getWorkspaceCourse(stageId: string): Promise<WorkspaceCourse | undefined> {
  const document = (await accessDocument(stageId)).document;
  if (!document) return undefined;
  await ensureWorkspaceMetadata(stageId);
  const [metadata, variant] = await Promise.all([
    db.courseMetadata.get(stageId),
    db.teacherVariants.get(stageId),
  ]);
  return metadata ? toWorkspaceCourse(document, metadata, variant) : undefined;
}

export async function listWorkspaceCourses(
  options: ListWorkspaceCoursesOptions = {},
): Promise<WorkspaceCourse[]> {
  await ensureWorkspaceMetadata();
  const [documents, metadataRecords, variants] = await Promise.all([
    loadWorkspaceDocuments(),
    db.courseMetadata.toArray(),
    db.teacherVariants.toArray(),
  ]);
  const metadataByStage = new Map(metadataRecords.map((record) => [record.stageId, record]));
  const variantByStage = new Map(variants.map((record) => [record.stageId, record]));
  const kinds = options.kind
    ? new Set(Array.isArray(options.kind) ? options.kind : [options.kind])
    : undefined;
  const search = options.search?.trim().toLocaleLowerCase();
  let courses = documents.flatMap((document): WorkspaceCourse[] => {
    const metadata = metadataByStage.get(document.stage.id);
    if (!metadata) return [];
    if (!options.includeArchived && metadata.archived) return [];
    if (kinds && !kinds.has(metadata.kind)) return [];
    if (options.domain && metadata.domain !== options.domain) return [];
    if (options.subject && metadata.subject !== options.subject) return [];
    if (options.offlineStatus && metadata.offlineStatus !== options.offlineStatus) return [];
    if (options.favorite !== undefined && metadata.favorite !== options.favorite) return [];
    if (search) {
      const searchable = [
        metadata.title,
        metadata.summary,
        metadata.subject,
        metadata.category,
        metadata.author,
        ...metadata.tags,
        ...metadata.gradeBands,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
        .toLocaleLowerCase();
      if (!searchable.includes(search)) return [];
    }
    return [toWorkspaceCourse(document, metadata, variantByStage.get(document.stage.id))];
  });

  const sort = options.sort ?? 'updated_desc';
  courses.sort((left, right) => {
    if (sort === 'title_asc') {
      return left.metadata.title.localeCompare(right.metadata.title, 'zh-CN');
    }
    if (sort === 'created_desc') return right.metadata.createdAt - left.metadata.createdAt;
    if (sort === 'last_opened_desc') {
      return (
        (right.metadata.lastOpenedAt ?? 0) - (left.metadata.lastOpenedAt ?? 0) ||
        right.metadata.updatedAt - left.metadata.updatedAt
      );
    }
    return right.metadata.updatedAt - left.metadata.updatedAt;
  });

  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  courses = courses.slice(offset);
  if (options.limit !== undefined) {
    courses = courses.slice(0, Math.max(0, Math.floor(options.limit)));
  }
  return courses;
}

export async function upsertCourseMetadata(
  stageId: string,
  patch: CourseMetadataPatch = {},
): Promise<CourseMetadataRecord> {
  const document = (await accessDocument(stageId)).document;
  if (!document) throw new Error(`Course not found: ${stageId}`);
  await ensureWorkspaceMetadata(stageId);
  const [existing, variant] = await Promise.all([
    db.courseMetadata.get(stageId),
    db.teacherVariants.get(stageId),
  ]);
  if (!existing) throw new Error(`Course metadata not found: ${stageId}`);

  const now = Date.now();
  const title = hasOwn(patch, 'title') ? patch.title?.trim() : existing.title;
  if (!title) throw new Error('Course title cannot be empty');
  const summary = hasOwn(patch, 'summary') ? patch.summary : existing.summary;
  const next: CourseMetadataRecord = {
    ...existing,
    ...patch,
    stageId,
    title,
    summary,
    kind: variant ? 'teacher_variant' : (patch.kind ?? existing.kind),
    gradeBands: normalizeStringList(patch.gradeBands) ?? existing.gradeBands,
    tags: normalizeStringList(patch.tags) ?? existing.tags,
    source: { ...existing.source, ...patch.source },
    createdAt: existing.createdAt,
    updatedAt: now,
  };
  if (variant) {
    next.source = {
      ...next.source,
      kind: 'teacher_variant',
      sourceStageId: variant.baseStageId,
      sourceCourseId: variant.rootStageId,
    };
  }

  const updatesDocument = hasOwn(patch, 'title') || hasOwn(patch, 'summary');
  if (updatesDocument) {
    await mutateDocument(stageId, async (current, documentStore) => {
      if (!current) throw new Error(`Course not found: ${stageId}`);
      await documentStore.saveDocument({
        ...current,
        stage: { ...current.stage, name: title, description: summary, updatedAt: now },
      });
    });
  }
  try {
    await db.courseMetadata.put(next);
  } catch (metadataError) {
    if (updatesDocument) {
      try {
        await mutateDocument(stageId, async (current, documentStore) => {
          if (!current) return;
          // Preserve any later document mutation instead of rolling the whole
          // aggregate back. When our stage stamp is still current, restore only
          // the fields this workspace operation changed.
          if (
            current.stage.updatedAt === now &&
            current.stage.name === title &&
            current.stage.description === summary
          ) {
            await documentStore.saveDocument({
              ...current,
              stage: {
                ...current.stage,
                name: document.stage.name,
                description: document.stage.description,
                updatedAt: document.stage.updatedAt,
              },
            });
          }
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [metadataError, rollbackError],
          `Course metadata update failed and document rollback also failed: ${stageId}`,
        );
      }
    }
    throw metadataError;
  }
  return next;
}

export async function getTeacherVariant(
  stageId: string,
): Promise<TeacherVariantRecord | undefined> {
  return db.teacherVariants.get(stageId);
}

export async function listTeacherVariants(baseStageId?: string): Promise<TeacherVariantRecord[]> {
  const records = baseStageId
    ? await db.teacherVariants.where('baseStageId').equals(baseStageId).toArray()
    : await db.teacherVariants.toArray();
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function createTeacherVariant(
  baseStageId: string,
  options: CreateTeacherVariantOptions = {},
): Promise<WorkspaceCourse> {
  const store = getDocumentStore();
  const sourceDocument = (await accessDocument(baseStageId)).document;
  if (!sourceDocument) throw new Error(`Course not found: ${baseStageId}`);
  await ensureWorkspaceMetadata(baseStageId);
  const destinationStageId = options.stageId?.trim() || nanoid();
  if (destinationStageId === baseStageId) {
    throw new Error('Teacher variant must use a new course id');
  }
  if (
    (await store.loadDocument(destinationStageId)) ||
    (await db.courseMetadata.get(destinationStageId))
  ) {
    throw new Error(`Course id already exists: ${destinationStageId}`);
  }

  const [sourceMetadata, sourceVariant] = await Promise.all([
    db.courseMetadata.get(baseStageId),
    db.teacherVariants.get(baseStageId),
  ]);
  if (!sourceMetadata) throw new Error(`Course metadata not found: ${baseStageId}`);

  const sceneIds = new Map(sourceDocument.scenes.map((scene) => [scene.id, nanoid()]));
  const agentIds = new Map<string, string>();
  for (const agentId of sourceDocument.stage.agentIds ?? []) agentIds.set(agentId, nanoid());
  for (const agent of sourceDocument.stage.generatedAgentConfigs ?? []) {
    if (!agentIds.has(agent.id)) agentIds.set(agent.id, nanoid());
  }
  const references = new Map<string, string>([[baseStageId, destinationStageId]]);
  for (const mapping of [sceneIds, agentIds]) {
    for (const [from, to] of mapping) references.set(from, to);
  }

  const rootStageId = sourceVariant?.rootStageId ?? baseStageId;
  const metadataPatch = options.metadata ?? {};
  const requestedTitle = options.name ?? metadataPatch.title;
  const title =
    requestedTitle?.trim() || `${sourceMetadata.title || sourceDocument.stage.name} · 我的适配版`;
  const description =
    options.description ??
    metadataPatch.summary ??
    sourceMetadata.summary ??
    sourceDocument.stage.description;
  const now = Date.now();
  const rewritten = rewriteReferences(sourceDocument, references);
  const clonedDocument: AppDocument = {
    ...rewritten,
    stage: {
      ...rewritten.stage,
      id: destinationStageId,
      name: title,
      description,
      style: options.style ?? rewritten.stage.style,
      createdAt: now,
      updatedAt: now,
    },
    scenes: rewritten.scenes.map((scene) => ({
      ...scene,
      stageId: destinationStageId,
      createdAt: now,
      updatedAt: now,
    })),
  };
  const variant: TeacherVariantRecord = {
    stageId: destinationStageId,
    baseStageId,
    rootStageId,
    label: options.label,
    teachingStyle:
      options.teachingStyle ??
      metadataPatch.teachingStyle ??
      sourceMetadata.teachingStyle ??
      options.style,
    baseUpdatedAt: sourceDocument.stage.updatedAt,
    createdAt: now,
    updatedAt: now,
  };
  const metadata: CourseMetadataRecord = {
    ...sourceMetadata,
    ...metadataPatch,
    stageId: destinationStageId,
    title,
    summary: description,
    kind: 'teacher_variant',
    gradeBands: normalizeStringList(metadataPatch.gradeBands) ?? [...sourceMetadata.gradeBands],
    tags: normalizeStringList(metadataPatch.tags) ?? [...sourceMetadata.tags],
    source: {
      ...sourceMetadata.source,
      ...metadataPatch.source,
      kind: 'teacher_variant',
      sourceName: sourceMetadata.title,
      sourceStageId: baseStageId,
      sourceCourseId: rootStageId,
      importedAt: now,
    },
    teachingStyle: variant.teachingStyle,
    favorite: metadataPatch.favorite ?? false,
    archived: metadataPatch.archived ?? false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: undefined,
  };

  await mutateDocument(destinationStageId, async (existing, documentStore) => {
    if (existing) throw new Error(`Course id already exists: ${destinationStageId}`);
    await documentStore.saveDocument(clonedDocument);
  });
  try {
    await db.transaction('rw', [db.courseMetadata, db.teacherVariants], async () => {
      await db.teacherVariants.add(variant);
      await db.courseMetadata.add(metadata);
    });
  } catch (error) {
    try {
      await mutateDocument(destinationStageId, async (existing, documentStore) => {
        // Only remove the document written by this operation. A same-id course
        // recreated after our write owns a different creation stamp and must
        // not be deleted by compensation.
        if (existing?.stage.createdAt === now) {
          await documentStore.deleteDocument(destinationStageId);
        }
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Teacher variant metadata failed and document cleanup also failed: ${destinationStageId}`,
      );
    }
    throw error;
  }

  return toWorkspaceCourse(clonedDocument, metadata, variant);
}

export async function startImportJob(input: StartImportJobInput): Promise<ImportJobRecord> {
  const now = Date.now();
  const status = input.status ?? 'queued';
  const record: ImportJobRecord = {
    id: nanoid(),
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    sourceSize: input.sourceSize,
    status,
    progress: status === 'completed' ? 100 : 0,
    detectedTitle: input.detectedTitle,
    formatVersion: input.formatVersion,
    offlineStatus: 'unchecked',
    warnings: [],
    createdAt: now,
    updatedAt: now,
    completedAt: ['completed', 'failed', 'cancelled'].includes(status) ? now : undefined,
  };
  await db.importJobs.add(record);
  return record;
}

export async function updateImportJob(id: string, patch: ImportJobPatch): Promise<ImportJobRecord> {
  return db.transaction('rw', db.importJobs, async () => {
    const existing = await db.importJobs.get(id);
    if (!existing) throw new Error(`Import job not found: ${id}`);
    const status = patch.status ?? existing.status;
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    const next: ImportJobRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      sourceType: existing.sourceType,
      sourceName: existing.sourceName,
      progress: status === 'completed' ? 100 : clampProgress(patch.progress ?? existing.progress),
      warnings: patch.warnings ? [...patch.warnings] : existing.warnings,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
      completedAt: terminal ? (patch.completedAt ?? existing.completedAt ?? Date.now()) : undefined,
    };
    await db.importJobs.put(next);
    return next;
  });
}

export async function completeImportJob(
  id: string,
  stageId: string,
  patch: ImportJobPatch = {},
): Promise<ImportJobRecord> {
  return updateImportJob(id, {
    ...patch,
    stageId,
    status: 'completed',
    progress: 100,
    error: undefined,
    completedAt: Date.now(),
  });
}

function normalizeImportError(error: ImportJobIssue | Error | string): ImportJobIssue {
  if (typeof error === 'string') return { code: 'import_failed', message: error };
  if (error instanceof Error) {
    return { code: error.name || 'import_failed', message: error.message || 'Import failed' };
  }
  return error;
}

export async function failImportJob(
  id: string,
  error: ImportJobIssue | Error | string,
  patch: ImportJobPatch = {},
): Promise<ImportJobRecord> {
  return updateImportJob(id, {
    ...patch,
    status: 'failed',
    error: normalizeImportError(error),
    completedAt: Date.now(),
  });
}

export async function listImportJobs(
  options: ListImportJobsOptions = {},
): Promise<ImportJobRecord[]> {
  let records = await db.importJobs.orderBy('createdAt').reverse().toArray();
  const statuses = options.status
    ? new Set(Array.isArray(options.status) ? options.status : [options.status])
    : undefined;
  if (statuses) records = records.filter((record) => statuses.has(record.status));
  if (options.sourceType) {
    records = records.filter((record) => record.sourceType === options.sourceType);
  }
  if (options.stageId) records = records.filter((record) => record.stageId === options.stageId);
  if (options.limit !== undefined) {
    records = records.slice(0, Math.max(0, Math.floor(options.limit)));
  }
  return records;
}

export async function getWorkspaceStats(): Promise<WorkspaceStats> {
  await ensureWorkspaceMetadata();
  const store = getDocumentStore();
  const [summaries, metadataRecords, importJobs] = await Promise.all([
    store.listDocuments(),
    db.courseMetadata.toArray(),
    db.importJobs.toArray(),
  ]);
  const stageIds = new Set(summaries.map((stage) => stage.id));
  const metadata = metadataRecords.filter((record) => stageIds.has(record.stageId));
  const importInProgress = importJobs.filter((job) => IMPORT_IN_PROGRESS.has(job.status)).length;
  let locallyStoredAssetBytes = 0;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      locallyStoredAssetBytes = (await navigator.storage.estimate()).usage ?? 0;
    } catch {
      // Storage estimates are advisory and can be unavailable in private mode.
    }
  }

  return {
    totalCourses: metadata.length,
    originalCourses: metadata.filter((record) => record.kind === 'original').length,
    teacherVariants: metadata.filter((record) => record.kind === 'teacher_variant').length,
    publishedCourses: metadata.filter((record) => record.kind === 'published').length,
    favorites: metadata.filter((record) => record.favorite).length,
    archived: metadata.filter((record) => record.archived).length,
    offlineComplete: metadata.filter((record) => record.offlineStatus === 'complete').length,
    offlinePartial: metadata.filter((record) => record.offlineStatus === 'partial').length,
    networkRequired: metadata.filter((record) => record.offlineStatus === 'network_required')
      .length,
    offlineUnchecked: metadata.filter((record) => record.offlineStatus === 'unchecked').length,
    totalScenes: summaries.reduce((sum, stage) => sum + stage.sceneCount, 0),
    imports: {
      total: importJobs.length,
      completed: importJobs.filter((job) => job.status === 'completed').length,
      failed: importJobs.filter((job) => job.status === 'failed').length,
      inProgress: importInProgress,
    },
    locallyStoredAssetBytes,
  };
}
