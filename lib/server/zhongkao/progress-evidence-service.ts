import { ExamError } from '@/lib/zhongkao/exam-errors';
import type { ProgressEvidence } from '@/lib/zhongkao/progress';
import { loadStudentProfile, loadStudyAttempts } from '@/lib/zhongkao/runtime';

import { resolveConfirmedExamObservationsFromRuntime } from './exam-knowledge-mapping-service';
import {
  listProfileExamRuntimeSnapshots,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import type { ExamServiceDeps } from './exam-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

export interface CollectedKnowledgeProgressEvidence {
  profileId: string;
  evidence: ProgressEvidence[];
  studyAttemptCount: number;
  examObservationCount: number;
  activeExamCount: number;
}

function canContributeExamEvidence(snapshot: ExamRuntimeSnapshot): boolean {
  return (
    snapshot.state.status === 'ready_for_extraction' &&
    snapshot.state.observationProjection?.status === 'completed'
  );
}

function compareEvidence(left: ProgressEvidence, right: ProgressEvidence): number {
  const leftAt =
    left.sourceKind === 'study_attempt' ? left.attempt.createdAt : left.observation.observedAt;
  const rightAt =
    right.sourceKind === 'study_attempt' ? right.attempt.createdAt : right.observation.observedAt;
  const timestampOrder = Date.parse(leftAt) - Date.parse(rightAt);
  if (timestampOrder !== 0) return timestampOrder;
  const leftId =
    left.sourceKind === 'study_attempt' ? left.attempt.id : left.observation.observationId;
  const rightId =
    right.sourceKind === 'study_attempt' ? right.attempt.id : right.observation.observationId;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export async function collectKnowledgeProgressEvidence(
  deps: ExamServiceDeps,
  profileId: string,
): Promise<CollectedKnowledgeProgressEvidence> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const profile = await loadStudentProfile(profileId, { store: deps.store, learnerKey });
  if (!profile || profile.profileId !== profileId) {
    throw new ExamError('EXAM_PROFILE_NOT_FOUND');
  }

  const attempts = await loadStudyAttempts(profileId, { store: deps.store, learnerKey });
  const listedExams = await listProfileExamRuntimeSnapshots(deps, profileId);
  const observations: ProgressEvidence[] = [];
  let activeExamCount = 0;

  for (const listed of listedExams) {
    if (listed.state.profileId !== profileId || !canContributeExamEvidence(listed)) continue;
    const projected = await deps.withExamMutationLock(listed.state.examSessionId, async () => {
      const current = await loadExamRuntime(deps, listed.state.examSessionId);
      if (current.state.profileId !== profileId || !canContributeExamEvidence(current)) return [];
      const artifact = await resolveConfirmedExamObservationsFromRuntime(deps, current);
      return artifact.observations;
    });
    if (projected.length === 0) continue;
    activeExamCount += 1;
    observations.push(
      ...projected.map(
        (observation): ProgressEvidence => ({ sourceKind: 'exam_observation', observation }),
      ),
    );
  }

  const evidence: ProgressEvidence[] = [
    ...attempts.map((attempt): ProgressEvidence => ({ sourceKind: 'study_attempt', attempt })),
    ...observations,
  ].toSorted(compareEvidence);
  return {
    profileId,
    evidence,
    studyAttemptCount: attempts.length,
    examObservationCount: observations.length,
    activeExamCount,
  };
}
