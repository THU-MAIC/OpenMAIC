import type { StudyAttempt } from '@/lib/zhongkao/study-attempt';

export const NOW = '2026-08-28T08:00:00.000Z';

export function studyAttempt(overrides: Partial<StudyAttempt> = {}): StudyAttempt {
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
