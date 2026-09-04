import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { RuntimeStore } from '@openmaic/storage';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  EXAM_DISPLAY_NAME_MAX_LENGTH,
  EXAM_MAX_DOCUMENT_BYTES,
  EXAM_MAX_TOTAL_BYTES,
  EXAM_SCHEMA_VERSION,
  EXAM_SUPPORTED_MIME_TYPES,
  examRequestSemanticFacts,
  isExamSupportedMimeType,
  parseExamCreateRequest,
  type ExamCreateRequest,
  type PublicExamSession,
} from '@/lib/zhongkao/exam';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamCreatedDocument,
  type ExamCreatedEvent,
  type ExamDeleteRequestedEvent,
  type ExamDeletedEvent,
  type ExamDocumentSnapshottedEvent,
  type ExamIntakeCompletedEvent,
} from '@/lib/zhongkao/exam-event';
import { toPublicExamSession, type ExamDocumentState } from '@/lib/zhongkao/exam-state';
import { loadStudentProfile } from '@/lib/zhongkao/runtime';
import {
  getMaterialByteStore,
  MaterialByteStoreError,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  examAuthoritativeAnswerKeyObjectKey,
  examDocumentArtifactObjectKey,
  examErrorSuggestionsObjectKey,
  examHumanReviewObjectKey,
  examKnowledgeMappingObjectKey,
  examKnowledgeSuggestionsObjectKey,
  examObservationsObjectKey,
  examQuestionCandidatesObjectKey,
  examQuestionAssessmentsObjectKey,
  examQuestionResponseMatchesObjectKey,
  examSnapshotObjectKey,
  examSnapshotObjectPrefix,
  examStudentResponseCandidatesObjectKey,
} from '@/lib/server/materials/object-keys';
import {
  resolveOwnedReadyMaterialAssetsForSnapshot,
  type OwnerMaterialSnapshotSourceResult,
  type VerifiedOwnerMaterialAsset,
} from '@/lib/server/materials/owner-assets';

import { type ExamMutationLock, serverExamMutationLock } from './exam-mutation-lock';
import {
  appendExamRuntimeEvent,
  createExamDocumentSetFingerprint,
  createExamOperationFingerprint,
  createExamRequestFingerprint,
  deriveExamCreatedOperationId,
  deriveExamDeleteRequestedOperationId,
  deriveExamDeletedOperationId,
  deriveExamDocumentId,
  deriveExamEventId,
  deriveExamIntakeCompletedOperationId,
  deriveExamSessionId,
  deriveExamSnapshotOperationId,
  ensureExamRuntimeCreated,
  loadExamRuntime,
  type ExamRuntimeDeps,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

const ALLOWED_MIME_TYPES = new Set<string>(EXAM_SUPPORTED_MIME_TYPES);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

export type ExamSourceCapture = (
  ownerId: string,
  materialIds: readonly string[],
) => Promise<OwnerMaterialSnapshotSourceResult>;

export interface ExamServiceDeps extends ExamRuntimeDeps {
  byteStore: MaterialByteStore;
  withExamMutationLock: ExamMutationLock;
  captureSources: ExamSourceCapture;
  now?: () => string;
}

export interface CreateExamResult {
  exam: PublicExamSession;
  replayed: boolean;
}

export interface ResolvedExamDocumentSnapshot {
  examSessionId: string;
  examDocumentId: string;
  role: ExamDocumentState['role'];
  mimeType: ExamDocumentState['mimeType'];
  byteLength: number;
  displayName?: string;
  bytes: Buffer;
}

function now(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function safeDisplayName(value: string | null): string | undefined {
  if (!value) return undefined;
  const leaf = basename(value.replaceAll('\\', '/')).trim();
  if (
    leaf.length === 0 ||
    leaf.length > EXAM_DISPLAY_NAME_MAX_LENGTH ||
    CONTROL_CHARACTER.test(leaf) ||
    UNPAIRED_SURROGATE.test(leaf)
  ) {
    return undefined;
  }
  return leaf;
}

function sourceError(result: Extract<OwnerMaterialSnapshotSourceResult, { ok: false }>): never {
  switch (result.reason) {
    case 'integrity_failed':
      throw new ExamError('EXAM_SOURCE_INTEGRITY_FAILED');
    case 'unsupported_mime':
      throw new ExamError('EXAM_INPUT_INVALID');
    case 'unavailable':
      throw new ExamError('EXAM_SOURCE_UNAVAILABLE');
  }
}

async function capture(
  deps: ExamServiceDeps,
  documents: readonly { ownerMaterialId: string }[],
): Promise<Map<string, VerifiedOwnerMaterialAsset>> {
  let result: OwnerMaterialSnapshotSourceResult;
  try {
    result = await deps.captureSources(
      deps.ownerId,
      documents.map((document) => document.ownerMaterialId),
    );
  } catch {
    throw new ExamError('EXAM_SOURCE_UNAVAILABLE');
  }
  if (!result.ok) return sourceError(result);
  const assets = new Map(result.assets.map((asset) => [asset.ownerMaterialId, asset]));
  if (documents.some((document) => !assets.has(document.ownerMaterialId))) {
    throw new ExamError('EXAM_SOURCE_UNAVAILABLE');
  }
  return assets;
}

function assertSourceBounds(
  documents: readonly { ownerMaterialId: string }[],
  assets: ReadonlyMap<string, VerifiedOwnerMaterialAsset>,
): void {
  let totalBytes = 0;
  for (const document of documents) {
    const asset = assets.get(document.ownerMaterialId);
    if (
      !asset ||
      asset.byteLength < 1 ||
      asset.byteLength > EXAM_MAX_DOCUMENT_BYTES ||
      !isExamSupportedMimeType(asset.mimeType)
    ) {
      throw new ExamError('EXAM_INPUT_INVALID');
    }
    totalBytes += asset.byteLength;
  }
  if (totalBytes > EXAM_MAX_TOTAL_BYTES) throw new ExamError('EXAM_INPUT_INVALID');
}

function declarations(
  examSessionId: string,
  request: ExamCreateRequest,
  assets: ReadonlyMap<string, VerifiedOwnerMaterialAsset>,
): ExamCreatedDocument[] {
  assertSourceBounds(request.documents, assets);
  return request.documents.map((document) => {
    const asset = assets.get(document.ownerMaterialId)!;
    const displayName = safeDisplayName(asset.record.originalName);
    return {
      examDocumentId: deriveExamDocumentId(examSessionId, document.role),
      role: document.role,
      ownerMaterialId: document.ownerMaterialId,
      sourceSha256: asset.sha256,
      mimeType: asset.mimeType as ExamCreatedDocument['mimeType'],
      byteLength: asset.byteLength,
      ...(displayName === undefined ? {} : { displayName }),
    };
  });
}

function createdEvent(input: {
  deps: ExamServiceDeps;
  request: ExamCreateRequest;
  examSessionId: string;
  requestFingerprint: string;
  documents: readonly ExamCreatedDocument[];
}): ExamCreatedEvent {
  const documentSetFingerprint = createExamDocumentSetFingerprint(input.documents);
  const operationId = deriveExamCreatedOperationId(input.examSessionId);
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_created',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: input.examSessionId,
    profileId: input.request.profileId,
    subjectId: input.request.subjectId,
    title: input.request.title,
    requestFingerprint: input.requestFingerprint,
    documentSetFingerprint,
    documents: input.documents,
  });
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: input.examSessionId,
    profileId: input.request.profileId,
    eventType: 'exam_created',
    createdAt: now(input.deps),
    operationId,
    operationFingerprint,
    subjectId: input.request.subjectId,
    ...(input.request.title === undefined ? {} : { title: input.request.title }),
    requestFingerprint: input.requestFingerprint,
    documentSetFingerprint,
    documents: input.documents,
  };
}

function snapshotEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
): ExamDocumentSnapshottedEvent {
  const operationId = deriveExamSnapshotOperationId(
    snapshot.state.examSessionId,
    document.examDocumentId,
  );
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_document_snapshotted',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    examDocumentId: document.examDocumentId,
    snapshotSha256: document.sourceSha256,
    byteLength: document.byteLength,
  });
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_document_snapshotted',
    createdAt: now(deps),
    operationId,
    operationFingerprint,
    examDocumentId: document.examDocumentId,
    snapshotSha256: document.sourceSha256,
    byteLength: document.byteLength,
  };
}

function completedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): ExamIntakeCompletedEvent {
  const operationId = deriveExamIntakeCompletedOperationId(
    snapshot.state.examSessionId,
    snapshot.state.documentSetFingerprint,
  );
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_intake_completed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
  });
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_intake_completed',
    createdAt: now(deps),
    operationId,
    operationFingerprint,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
  };
}

function isMissingBytes(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

async function readBytes(byteStore: MaterialByteStore, key: string): Promise<Buffer | undefined> {
  try {
    return await byteStore.get(key);
  } catch (error) {
    if (isMissingBytes(error)) return undefined;
    throw new ExamError('EXAM_SNAPSHOT_FAILED');
  }
}

async function readAndVerify(
  deps: ExamServiceDeps,
  state: { examSessionId: string },
  document: ExamDocumentState,
  missingAllowed: boolean,
): Promise<Buffer | undefined> {
  const key = examSnapshotObjectKey(state.examSessionId, document.examDocumentId);
  const bytes = await readBytes(deps.byteStore, key);
  if (!bytes) {
    if (missingAllowed) return undefined;
    throw new ExamError('EXAM_SNAPSHOT_INTEGRITY_FAILED');
  }
  const verified = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== document.byteLength || verified !== document.sourceSha256) {
    throw new ExamError(
      document.snapshot ? 'EXAM_SNAPSHOT_INTEGRITY_FAILED' : 'EXAM_DOCUMENT_CONFLICT',
    );
  }
  return bytes;
}

async function appendSnapshotFact(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event: snapshotEvent(deps, snapshot, document),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_SNAPSHOT_FAILED');
  }
}

async function ensureSnapshotBytes(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
  source: VerifiedOwnerMaterialAsset,
): Promise<void> {
  const key = examSnapshotObjectKey(snapshot.state.examSessionId, document.examDocumentId);
  try {
    await deps.byteStore.put(key, source.bytes, document.mimeType);
  } catch {
    const recovered = await readBytes(deps.byteStore, key).catch(() => undefined);
    if (!recovered) throw new ExamError('EXAM_SNAPSHOT_FAILED');
  }
  await readAndVerify(deps, snapshot.state, document, false);
}

async function ensureIntake(
  deps: ExamServiceDeps,
  initial: ExamRuntimeSnapshot,
  initialSources?: ReadonlyMap<string, VerifiedOwnerMaterialAsset>,
): Promise<ExamRuntimeSnapshot> {
  let snapshot = initial;
  if (snapshot.state.status === 'ready_for_extraction') {
    for (const document of snapshot.state.documents) {
      await readAndVerify(deps, snapshot.state, document, false);
    }
    return snapshot;
  }
  if (snapshot.state.status !== 'intake_pending') throw new ExamError('EXAM_NOT_FOUND');

  const missingSourceDocuments: ExamDocumentState[] = [];
  for (const document of snapshot.state.documents) {
    if (document.snapshot) {
      await readAndVerify(deps, snapshot.state, document, false);
      continue;
    }
    const existing = await readAndVerify(deps, snapshot.state, document, true);
    if (existing) {
      snapshot = await appendSnapshotFact(deps, snapshot, document);
    } else {
      missingSourceDocuments.push(document);
    }
  }

  let sources = initialSources;
  if (missingSourceDocuments.length > 0 && !sources) {
    sources = await capture(deps, missingSourceDocuments);
    assertSourceBounds(missingSourceDocuments, sources);
  }

  for (const original of missingSourceDocuments) {
    const document = snapshot.state.documents.find(
      (candidate) => candidate.examDocumentId === original.examDocumentId,
    );
    if (!document) throw new ExamError('EXAM_EVENT_CONFLICT');
    if (document.snapshot) continue;
    const source = sources?.get(document.ownerMaterialId);
    if (
      !source ||
      source.sha256 !== document.sourceSha256 ||
      source.byteLength !== document.byteLength ||
      source.mimeType !== document.mimeType
    ) {
      throw new ExamError('EXAM_SOURCE_INTEGRITY_FAILED');
    }
    await ensureSnapshotBytes(deps, snapshot, document, source);
    snapshot = await appendSnapshotFact(deps, snapshot, document);
  }

  for (const document of snapshot.state.documents) {
    if (!document.snapshot) throw new ExamError('EXAM_SNAPSHOT_FAILED');
    await readAndVerify(deps, snapshot.state, document, false);
  }
  try {
    snapshot = (
      await appendExamRuntimeEvent(deps, {
        event: completedEvent(deps, snapshot),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_SNAPSHOT_FAILED');
  }
  if (snapshot.state.status !== 'ready_for_extraction') {
    throw new ExamError('EXAM_SNAPSHOT_FAILED');
  }
  return snapshot;
}

async function assertProfileAuthority(deps: ExamServiceDeps, profileId: string): Promise<string> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  let profile;
  try {
    profile = await loadStudentProfile(profileId, { store: deps.store, learnerKey });
  } catch {
    throw new ExamError('EXAM_SESSION_CONFLICT');
  }
  if (!profile || profile.profileId !== profileId) throw new ExamError('EXAM_PROFILE_NOT_FOUND');
  return learnerKey;
}

export async function createExam(deps: ExamServiceDeps, input: unknown): Promise<CreateExamResult> {
  const request = parseExamCreateRequest(input);
  const learnerKey = await assertProfileAuthority(deps, request.profileId);
  const examSessionId = deriveExamSessionId({
    learnerKey,
    profileId: request.profileId,
    clientRequestId: request.clientRequestId,
  });
  const requestFingerprint = createExamRequestFingerprint(examRequestSemanticFacts(request));

  return deps.withExamMutationLock(examSessionId, async () => {
    let existing: ExamRuntimeSnapshot | undefined;
    let existingSessionWithoutCreatedEvent = false;
    try {
      existing = await loadExamRuntime(deps, examSessionId);
    } catch (error) {
      if (!isExamError(error)) throw error;
      if (error.code === 'EXAM_EVENT_CONFLICT') {
        // createSession may have committed immediately before a crash. The
        // immutable plan is reconstructed from re-verified sources below;
        // ensureExamRuntimeCreated still rejects any non-empty corrupt history.
        existingSessionWithoutCreatedEvent = true;
      } else if (error.code !== 'EXAM_NOT_FOUND') {
        throw error;
      }
    }
    const replayed = existing !== undefined;
    if (existing) {
      if (existing.state.requestFingerprint !== requestFingerprint) {
        throw new ExamError('EXAM_REQUEST_CONFLICT');
      }
      const snapshot = await ensureIntake(deps, existing);
      return { exam: toPublicExamSession(snapshot.state), replayed: true };
    }

    const sourceAssets = await capture(deps, request.documents);
    const declaredDocuments = declarations(examSessionId, request, sourceAssets);
    const event = createdEvent({
      deps,
      request,
      examSessionId,
      requestFingerprint,
      documents: declaredDocuments,
    });
    let created: ExamRuntimeSnapshot;
    try {
      created = (await ensureExamRuntimeCreated(deps, event)).snapshot;
    } catch (error) {
      if (isExamError(error)) throw error;
      throw new ExamError('EXAM_SESSION_CONFLICT');
    }
    if (created.state.requestFingerprint !== requestFingerprint) {
      throw new ExamError('EXAM_REQUEST_CONFLICT');
    }
    const ready = await ensureIntake(deps, created, sourceAssets);
    return {
      exam: toPublicExamSession(ready.state),
      replayed: replayed || existingSessionWithoutCreatedEvent,
    };
  });
}

export async function getExam(
  deps: ExamRuntimeDeps,
  examSessionId: string,
): Promise<PublicExamSession> {
  const snapshot = await loadExamRuntime(deps, examSessionId);
  return toPublicExamSession(snapshot.state);
}

function deleteRequestedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): ExamDeleteRequestedEvent {
  const operationId = deriveExamDeleteRequestedOperationId(snapshot.state.examSessionId);
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_delete_requested',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
  });
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_delete_requested',
    createdAt: now(deps),
    operationId,
    operationFingerprint,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
  };
}

function deletedEvent(deps: ExamServiceDeps, snapshot: ExamRuntimeSnapshot): ExamDeletedEvent {
  if (!snapshot.state.deleteRequestedEventId) throw new ExamError('EXAM_EVENT_CONFLICT');
  const operationId = deriveExamDeletedOperationId(snapshot.state.examSessionId);
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_deleted',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
    deleteRequestEventId: snapshot.state.deleteRequestedEventId,
  });
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_deleted',
    createdAt: now(deps),
    operationId,
    operationFingerprint,
    documentSetFingerprint: snapshot.state.documentSetFingerprint,
    deleteRequestEventId: snapshot.state.deleteRequestedEventId,
  };
}

function examDerivativeObjectKeys(snapshot: ExamRuntimeSnapshot): string[] {
  const extraction = snapshot.state.questionExtraction;
  const keys: string[] = [];
  if (extraction) {
    keys.push(
      examDocumentArtifactObjectKey(
        snapshot.state.examSessionId,
        extraction.examDocumentId,
        extraction.extractionVersion,
      ),
    );
    if (extraction.segmentation) {
      keys.push(
        examQuestionCandidatesObjectKey(
          snapshot.state.examSessionId,
          extraction.examDocumentId,
          extraction.extractionVersion,
          extraction.segmentation.segmentationVersion,
        ),
      );
    }
  }
  const capture = snapshot.state.studentResponseCapture;
  if (capture) {
    keys.push(
      examStudentResponseCandidatesObjectKey(snapshot.state.examSessionId, capture.captureVersion),
      examQuestionResponseMatchesObjectKey(
        snapshot.state.examSessionId,
        capture.captureVersion,
        capture.matchingVersion,
      ),
    );
  }
  const review = snapshot.state.humanReview;
  if (review) {
    keys.push(
      examHumanReviewObjectKey(
        snapshot.state.examSessionId,
        review.responseCaptureVersion,
        review.matchingVersion,
        review.reviewVersion,
      ),
    );
  }
  const answerKey = snapshot.state.answerKey;
  if (answerKey) {
    keys.push(
      examAuthoritativeAnswerKeyObjectKey(snapshot.state.examSessionId, answerKey.answerKeyVersion),
    );
  }
  const grading = snapshot.state.grading;
  if (grading) {
    keys.push(
      examQuestionAssessmentsObjectKey(snapshot.state.examSessionId, grading.gradingVersion),
    );
  }
  const knowledgeSuggestions = snapshot.state.knowledgeSuggestions;
  if (knowledgeSuggestions) {
    keys.push(
      examKnowledgeSuggestionsObjectKey(
        snapshot.state.examSessionId,
        knowledgeSuggestions.generationVersion,
      ),
    );
  }
  const errorSuggestions = snapshot.state.errorSuggestions;
  if (errorSuggestions) {
    keys.push(
      examErrorSuggestionsObjectKey(
        snapshot.state.examSessionId,
        errorSuggestions.generationVersion,
      ),
    );
  }
  const knowledgeMapping = snapshot.state.knowledgeMapping;
  if (knowledgeMapping) {
    keys.push(
      examKnowledgeMappingObjectKey(snapshot.state.examSessionId, knowledgeMapping.mappingVersion),
    );
  }
  const observationProjection = snapshot.state.observationProjection;
  if (observationProjection) {
    keys.push(
      examObservationsObjectKey(
        snapshot.state.examSessionId,
        observationProjection.mappingVersion,
        observationProjection.observationVersion,
      ),
    );
  }
  return keys;
}

async function verifyDeleted(deps: ExamServiceDeps, snapshot: ExamRuntimeSnapshot): Promise<void> {
  const keys = [
    ...snapshot.state.documents.map((document) =>
      examSnapshotObjectKey(snapshot.state.examSessionId, document.examDocumentId),
    ),
    ...examDerivativeObjectKeys(snapshot),
  ];
  for (const key of keys) {
    try {
      await deps.byteStore.get(key);
      throw new ExamError('EXAM_DELETE_FAILED');
    } catch (error) {
      if (isMissingBytes(error)) continue;
      if (isExamError(error)) throw error;
      throw new ExamError('EXAM_DELETE_FAILED');
    }
  }
}

export async function deleteExam(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<'deleted' | 'already_deleted'> {
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status === 'deleted') return 'already_deleted';
    if (snapshot.state.status !== 'deleting') {
      try {
        snapshot = (
          await appendExamRuntimeEvent(deps, {
            event: deleteRequestedEvent(deps, snapshot),
            expectedRevision: snapshot.state.revision,
          })
        ).snapshot;
      } catch (error) {
        if (isExamError(error)) throw error;
        throw new ExamError('EXAM_DELETE_FAILED');
      }
    }

    try {
      for (const document of snapshot.state.documents) {
        await deps.byteStore.delete(
          examSnapshotObjectKey(snapshot.state.examSessionId, document.examDocumentId),
        );
      }
      for (const key of examDerivativeObjectKeys(snapshot)) {
        await deps.byteStore.delete(key);
      }
      if (deps.byteStore.deletePrefix) {
        await deps.byteStore.deletePrefix(examSnapshotObjectPrefix(snapshot.state.examSessionId));
      }
      await verifyDeleted(deps, snapshot);
    } catch (error) {
      if (isExamError(error)) throw error;
      throw new ExamError('EXAM_DELETE_FAILED');
    }

    try {
      snapshot = (
        await appendExamRuntimeEvent(deps, {
          event: deletedEvent(deps, snapshot),
          expectedRevision: snapshot.state.revision,
        })
      ).snapshot;
    } catch (error) {
      if (isExamError(error)) throw error;
      throw new ExamError('EXAM_DELETE_FAILED');
    }
    if (snapshot.state.status !== 'deleted') throw new ExamError('EXAM_DELETE_FAILED');
    return 'deleted';
  });
}

export async function resolveExamDocumentSnapshot(
  deps: ExamServiceDeps,
  examSessionId: string,
  examDocumentId: string,
): Promise<ResolvedExamDocumentSnapshot> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveExamDocumentSnapshotFromRuntime(deps, snapshot, examDocumentId);
  });
}

/** Read a verified snapshot while the caller already owns the per-Exam mutation lock. */
export async function resolveExamDocumentSnapshotFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  examDocumentId: string,
): Promise<ResolvedExamDocumentSnapshot> {
  if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
  const matches = snapshot.state.documents.filter(
    (document) => document.examDocumentId === examDocumentId,
  );
  if (matches.length !== 1 || !matches[0]!.snapshot) throw new ExamError('EXAM_NOT_FOUND');
  const document = matches[0]!;
  const bytes = await readAndVerify(deps, snapshot.state, document, false);
  if (!bytes) throw new ExamError('EXAM_SNAPSHOT_INTEGRITY_FAILED');
  return {
    examSessionId: snapshot.state.examSessionId,
    examDocumentId,
    role: document.role,
    mimeType: document.mimeType,
    byteLength: document.byteLength,
    ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
    bytes,
  };
}

export async function defaultExamServiceDeps(ownerId: string): Promise<ExamServiceDeps> {
  const connectionString = process.env.DATABASE_URL ?? '';
  const provider = await getServerPersistenceProvider(connectionString);
  const pool = provider.pool as unknown as ConnectableQueryable;
  const byteStore = getMaterialByteStore();
  const withTransaction = nodePostgresTransaction(pool);
  return {
    store: provider.runtimeStore as RuntimeStore,
    ownerId,
    byteStore,
    withExamMutationLock: serverExamMutationLock(connectionString),
    captureSources: (trustedOwnerId, materialIds) =>
      resolveOwnedReadyMaterialAssetsForSnapshot(
        trustedOwnerId,
        materialIds,
        { allowedMimeTypes: ALLOWED_MIME_TYPES },
        { withTransaction, byteStore },
      ),
  };
}

export const EXAM_INTAKE_LIMITS = Object.freeze({
  schemaVersion: EXAM_SCHEMA_VERSION,
  maxDocumentBytes: EXAM_MAX_DOCUMENT_BYTES,
  maxTotalBytes: EXAM_MAX_TOTAL_BYTES,
});
