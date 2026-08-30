import type {
  EvaluatedStudyAttemptV2,
  StudyAttemptV1,
  UnassessedStudyAttemptV2,
} from '@/lib/zhongkao/study-attempt';

export const NOW = '2026-08-28T08:00:00.000Z';

export function studyAttempt(overrides: Partial<StudyAttemptV1> = {}): StudyAttemptV1 {
  return {
    schemaVersion: 1,
    id: 'attempt-1',
    profileId: 'student-alpha',
    createdAt: NOW,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSummary: 'A fictional linear equation exercise',
    questionSourceType: 'typed',
    attemptKind: 'initial',
    initialOutcome: 'incorrect',
    finalOutcome: 'incorrect',
    studentAttemptedBeforeHelp: true,
    hintsUsed: 0,
    usedKeyHint: false,
    viewedFullAnswer: false,
    ...overrides,
  };
}

export function evaluatedStudyAttemptV2(
  overrides: Partial<EvaluatedStudyAttemptV2> = {},
): EvaluatedStudyAttemptV2 {
  return {
    schemaVersion: 2,
    id: 'coach-attempt-evaluated-1',
    coachSessionId: 'coach-session-alpha',
    profileId: 'student-alpha',
    createdAt: NOW,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSummary: 'A fictional generated linear equation exercise',
    questionSourceType: 'generated',
    attemptKind: 'transfer',
    assessmentStatus: 'evaluated',
    initialOutcome: 'correct',
    finalOutcome: 'correct',
    studentAttemptedBeforeHelp: true,
    hintsUsed: 0,
    usedKeyHint: false,
    viewedFullAnswer: false,
    ...overrides,
  };
}

export function unassessedStudyAttemptV2(
  overrides: Partial<UnassessedStudyAttemptV2> = {},
): UnassessedStudyAttemptV2 {
  return {
    schemaVersion: 2,
    id: 'coach-attempt-unassessed-1',
    coachSessionId: 'coach-session-alpha',
    profileId: 'student-alpha',
    createdAt: NOW,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSummary: 'A fictional open-ended original exercise',
    questionSourceType: 'typed',
    attemptKind: 'initial',
    assessmentStatus: 'unassessed',
    unassessedReason: 'unsupported_question_type',
    studentAttemptedBeforeHelp: true,
    hintsUsed: 1,
    usedKeyHint: true,
    viewedFullAnswer: true,
    ...overrides,
  };
}
