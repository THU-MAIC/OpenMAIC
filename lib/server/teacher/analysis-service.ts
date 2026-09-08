import { createHash, randomUUID } from 'node:crypto';

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import type { NextRequest } from 'next/server';

import {
  TEACHER_ANALYSIS_KIND,
  TeacherAnalysisError,
  createTeacherAnalysisSchema,
  teacherAnalysisSchema,
  updateTeacherAnalysisSchema,
  validateAnalysisCitations,
  validateTeacherAnalysis,
  type CreateTeacherAnalysis,
  type TeacherAnalysis,
  type TeacherAnalysisReport,
  type TeacherAnalysisSource,
} from '@/lib/teacher/analysis';
import { TeacherStudentError } from '@/lib/teacher/students';
import { zhongkaoStageId } from '@/lib/zhongkao/runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';

import {
  defaultTeacherStudentServiceDeps,
  getTeacherStudent,
  type TeacherStudentServiceDeps,
} from './students';

export const TEACHER_ANALYSES_PER_STUDENT_LIMIT = 100;
const APPEND_ATTEMPTS = 8;

export type TeacherAnalysisGenerator = (
  input: CreateTeacherAnalysis,
  signal?: AbortSignal,
) => Promise<{
  sources: TeacherAnalysisSource[];
  report: TeacherAnalysisReport;
  model: { providerId: string; modelId: string };
}>;

export interface TeacherAnalysisServiceDeps extends TeacherStudentServiceDeps {
  generate?: TeacherAnalysisGenerator;
}

interface AnalysisIdentity {
  id: string;
  kind: typeof TEACHER_ANALYSIS_KIND;
  stageId: string;
  learnerKey: string;
}

interface AnalysisSnapshot {
  identity: AnalysisIdentity;
  records: RuntimeRecord[];
  analyses: Map<string, TeacherAnalysis>;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function corruption(): never {
  throw new TeacherAnalysisError('ANALYSIS_STORAGE_CORRUPT');
}

function conflict(): never {
  throw new TeacherAnalysisError('ANALYSIS_CONFLICT');
}

export function safeTeacherAnalysisError(error: unknown): TeacherAnalysisError {
  if (error instanceof TeacherAnalysisError) return error;
  if (error instanceof TeacherStudentError) {
    if (error.code === 'TEACHER_STUDENT_NOT_FOUND') {
      return new TeacherAnalysisError('ANALYSIS_NOT_FOUND');
    }
    if (error.code === 'TEACHER_STUDENT_STORAGE_CORRUPT') {
      return new TeacherAnalysisError('ANALYSIS_STORAGE_CORRUPT');
    }
  }
  return new TeacherAnalysisError('ANALYSIS_UNAVAILABLE');
}

async function safely<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw safeTeacherAnalysisError(error);
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TeacherAnalysisError('ANALYSIS_CANCELED');
}

function timestamp(deps: TeacherAnalysisServiceDeps, after?: string): string {
  const value = Date.parse((deps.now ?? (() => new Date().toISOString()))());
  if (!Number.isFinite(value)) throw new TeacherAnalysisError('ANALYSIS_UNAVAILABLE');
  return new Date(Math.max(value, after ? Date.parse(after) + 1 : value)).toISOString();
}

function identityFor(deps: TeacherAnalysisServiceDeps, profileId: string): AnalysisIdentity {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  return {
    id: `teacher-analysis-session:v1:${hash([learnerKey, profileId])}`,
    kind: TEACHER_ANALYSIS_KIND,
    stageId: zhongkaoStageId(profileId),
    learnerKey,
  };
}

function analysisIdFor(identity: AnalysisIdentity, requestId: string): string {
  return `teacher-analysis:v1:${hash([identity.id, requestId])}`;
}

function assertSession(session: RuntimeSession, identity: AnalysisIdentity): void {
  if (
    session.id !== identity.id ||
    session.kind !== identity.kind ||
    session.stageId !== identity.stageId ||
    session.learnerKey !== identity.learnerKey ||
    session.status !== 'active'
  ) {
    corruption();
  }
}

function immutableFacts(analysis: TeacherAnalysis) {
  return {
    analysisId: analysis.analysisId,
    profileId: analysis.profileId,
    request: analysis.request,
    requestFingerprint: analysis.requestFingerprint,
    sources: analysis.sources,
    originalReport: analysis.originalReport,
    model: analysis.model,
    createdAt: analysis.createdAt,
  };
}

function validTransition(previous: TeacherAnalysis, next: TeacherAnalysis): boolean {
  if (previous.status === 'withdrawn') return false;
  if (next.status === 'draft') return next.reviewedAt === undefined;
  const unchanged =
    hash(previous.report) === hash(next.report) && previous.teacherComment === next.teacherComment;
  if (!unchanged) return false;
  if (next.status === 'reviewed') {
    return previous.status === 'draft' && next.reviewedAt === next.updatedAt;
  }
  return next.reviewedAt === previous.reviewedAt;
}

async function readSnapshot(
  deps: TeacherAnalysisServiceDeps,
  profileId: string,
): Promise<AnalysisSnapshot> {
  const identity = identityFor(deps, profileId);
  const session = await deps.store.getSession(identity.id);
  if (!session) return { identity, records: [], analyses: new Map() };
  assertSession(session, identity);
  const records = (await deps.store.listRecords(identity.id)).sort((a, b) => a.seq - b.seq);
  const analyses = new Map<string, TeacherAnalysis>();
  for (const [index, record] of records.entries()) {
    if (
      record.sessionId !== identity.id ||
      record.seq !== index ||
      !validateTeacherAnalysis(record.payload).valid
    ) {
      corruption();
    }
    const analysis = teacherAnalysisSchema.parse(record.payload);
    if (
      analysis.profileId !== profileId ||
      analysis.analysisId !== analysisIdFor(identity, analysis.request.requestId) ||
      analysis.requestFingerprint !== hash(analysis.request) ||
      record.createdAt !== analysis.updatedAt
    ) {
      corruption();
    }
    const previous = analyses.get(analysis.analysisId);
    if (
      previous
        ? hash(immutableFacts(previous)) !== hash(immutableFacts(analysis)) ||
          Date.parse(analysis.updatedAt) <= Date.parse(previous.updatedAt) ||
          !validTransition(previous, analysis)
        : analysis.status !== 'draft' ||
          analysis.updatedAt !== analysis.createdAt ||
          analysis.reviewedAt !== undefined ||
          hash(analysis.report) !== hash(analysis.originalReport)
    ) {
      corruption();
    }
    analyses.set(analysis.analysisId, analysis);
  }
  if (analyses.size > TEACHER_ANALYSES_PER_STUDENT_LIMIT) corruption();
  return { identity, records, analyses };
}

async function ensureSession(
  deps: TeacherAnalysisServiceDeps,
  identity: AnalysisIdentity,
): Promise<void> {
  const existing = await deps.store.getSession(identity.id);
  if (existing) return assertSession(existing, identity);
  const now = timestamp(deps);
  try {
    assertSession(
      await deps.store.createSession({
        ...identity,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }),
      identity,
    );
  } catch (error) {
    const winner = await deps.store.getSession(identity.id);
    if (!winner) throw error;
    assertSession(winner, identity);
  }
}

function replay(snapshot: AnalysisSnapshot, id: string, fingerprint: string) {
  const existing = snapshot.analyses.get(id);
  if (existing && existing.requestFingerprint !== fingerprint) conflict();
  return existing;
}

export async function listTeacherAnalyses(
  deps: TeacherAnalysisServiceDeps,
  profileId: string,
): Promise<TeacherAnalysis[]> {
  return safely(async () => {
    await getTeacherStudent(deps, profileId);
    const snapshot = await readSnapshot(deps, profileId);
    return [...snapshot.analyses.values()].sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        a.analysisId.localeCompare(b.analysisId),
    );
  });
}

export async function getTeacherAnalysis(
  deps: TeacherAnalysisServiceDeps,
  profileId: string,
  analysisId: string,
): Promise<TeacherAnalysis> {
  return safely(async () => {
    await getTeacherStudent(deps, profileId);
    const analysis = (await readSnapshot(deps, profileId)).analyses.get(analysisId);
    if (!analysis) throw new TeacherAnalysisError('ANALYSIS_NOT_FOUND');
    return analysis;
  });
}

export async function createTeacherAnalysis(
  deps: TeacherAnalysisServiceDeps,
  profileId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ analysis: TeacherAnalysis; replayed: boolean }> {
  return safely(async () => {
    const parsed = createTeacherAnalysisSchema.safeParse(input);
    if (!parsed.success) throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
    const request = parsed.data;
    checkAbort(signal);
    await getTeacherStudent(deps, profileId);
    let snapshot = await readSnapshot(deps, profileId);
    const analysisId = analysisIdFor(snapshot.identity, request.requestId);
    const fingerprint = hash(request);
    const existing = replay(snapshot, analysisId, fingerprint);
    if (existing) return { analysis: existing, replayed: true };
    if (snapshot.analyses.size >= TEACHER_ANALYSES_PER_STUDENT_LIMIT) {
      throw new TeacherAnalysisError('ANALYSIS_LIMIT_REACHED');
    }
    if (!deps.generate) throw new TeacherAnalysisError('ANALYSIS_MODEL_UNAVAILABLE');
    checkAbort(signal);
    let generated: Awaited<ReturnType<TeacherAnalysisGenerator>>;
    try {
      generated = await deps.generate(request, signal);
    } catch (error) {
      checkAbort(signal);
      if (error instanceof TeacherAnalysisError) throw error;
      throw new TeacherAnalysisError('ANALYSIS_MODEL_UNAVAILABLE');
    }
    checkAbort(signal);
    const now = timestamp(deps);
    const prepared = teacherAnalysisSchema.safeParse({
      schemaVersion: 1,
      analysisId,
      profileId,
      request,
      requestFingerprint: fingerprint,
      status: 'draft',
      sources: generated.sources,
      report: generated.report,
      originalReport: generated.report,
      model: generated.model,
      createdAt: now,
      updatedAt: now,
      teacherComment: '',
    });
    if (!prepared.success || !validateTeacherAnalysis(prepared.data).valid) {
      throw new TeacherAnalysisError('ANALYSIS_OUTPUT_INVALID');
    }
    const analysis = prepared.data;
    if (
      analysis.sources.length !== request.materials.length ||
      new Set(analysis.sources.map((source) => source.materialId)).size !==
        analysis.sources.length ||
      analysis.sources.some(
        (source) =>
          !request.materials.some(
            (material) =>
              material.materialId === source.materialId && material.role === source.role,
          ),
      )
    ) {
      throw new TeacherAnalysisError('ANALYSIS_SOURCE_INVALID');
    }
    await getTeacherStudent(deps, profileId);
    checkAbort(signal);
    await ensureSession(deps, snapshot.identity);
    // Generation stays outside CAS retries: competing writers only retry the append.
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      snapshot = await readSnapshot(deps, profileId);
      const winner = replay(snapshot, analysisId, fingerprint);
      if (winner) return { analysis: winner, replayed: true };
      if (snapshot.analyses.size >= TEACHER_ANALYSES_PER_STUDENT_LIMIT) {
        throw new TeacherAnalysisError('ANALYSIS_LIMIT_REACHED');
      }
      checkAbort(signal);
      try {
        await deps.store.appendRecord(
          {
            id: `teacher-analysis-create:${hash(analysisId)}`,
            sessionId: snapshot.identity.id,
            createdAt: analysis.updatedAt,
            payload: analysis,
          },
          { expectedLastSeq: snapshot.records.at(-1)?.seq ?? null },
        );
        return { analysis, replayed: false };
      } catch (error) {
        const recovered = await readSnapshot(deps, profileId);
        const committed = replay(recovered, analysisId, fingerprint);
        if (committed) return { analysis: committed, replayed: true };
        if (!(error instanceof RuntimeAppendConflictError)) throw error;
      }
    }
    return conflict();
  });
}

export async function updateTeacherAnalysis(
  deps: TeacherAnalysisServiceDeps,
  profileId: string,
  analysisId: string,
  input: unknown,
): Promise<TeacherAnalysis> {
  return safely(async () => {
    const parsed = updateTeacherAnalysisSchema.safeParse(input);
    if (!parsed.success) throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
    const request = parsed.data;
    await getTeacherStudent(deps, profileId);
    const recordId = `teacher-analysis-update:${randomUUID()}`;
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot(deps, profileId);
      const current = snapshot.analyses.get(analysisId);
      if (!current) throw new TeacherAnalysisError('ANALYSIS_NOT_FOUND');
      if (current.updatedAt !== request.expectedUpdatedAt || current.status === 'withdrawn')
        conflict();
      if (!validateAnalysisCitations(request.report, current.sources)) {
        throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
      }
      const unchanged =
        hash(current.report) === hash(request.report) &&
        current.teacherComment === request.teacherComment;
      if (request.action === 'confirm_review' && (current.status !== 'draft' || !unchanged))
        conflict();
      if (request.action === 'withdraw' && !unchanged) conflict();
      const now = timestamp(deps, current.updatedAt);
      const { reviewedAt: _reviewedAt, ...withoutReview } = current;
      const updated: TeacherAnalysis = {
        ...withoutReview,
        status:
          request.action === 'confirm_review'
            ? 'reviewed'
            : request.action === 'withdraw'
              ? 'withdrawn'
              : 'draft',
        report: request.report,
        teacherComment: request.teacherComment,
        updatedAt: now,
        ...(request.action === 'confirm_review' ? { reviewedAt: now } : {}),
        ...(request.action === 'withdraw' && current.reviewedAt
          ? { reviewedAt: current.reviewedAt }
          : {}),
      };
      if (!validateTeacherAnalysis(updated).valid)
        throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
      try {
        await deps.store.appendRecord(
          { id: recordId, sessionId: snapshot.identity.id, createdAt: now, payload: updated },
          { expectedLastSeq: snapshot.records.at(-1)?.seq ?? null },
        );
        return updated;
      } catch (error) {
        const recovered = await readSnapshot(deps, profileId);
        if (recovered.records.some((record) => record.id === recordId)) {
          return recovered.analyses.get(analysisId)!;
        }
        if (!(error instanceof RuntimeAppendConflictError)) throw error;
      }
    }
    return conflict();
  });
}

export async function defaultTeacherAnalysisServiceDeps(
  ownerId: string,
  req?: NextRequest,
): Promise<TeacherAnalysisServiceDeps> {
  return safely(async () => {
    const deps = await defaultTeacherStudentServiceDeps(ownerId);
    return {
      ...deps,
      ...(req
        ? {
            generate: async (input: CreateTeacherAnalysis, signal?: AbortSignal) => {
              const { createTeacherAnalysisGenerator } = await import('./analysis-generator');
              return createTeacherAnalysisGenerator(req, ownerId)(input, signal);
            },
          }
        : {}),
    };
  });
}
