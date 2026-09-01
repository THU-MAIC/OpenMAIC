export const ZHONGKAO_RUNTIME_KINDS = Object.freeze({
  studentProfile: 'zhongkaoStudentProfile',
  studyAttempt: 'zhongkaoStudyAttempt',
  coachEvent: 'zhongkaoCoachEvent',
  examEvent: 'zhongkaoExamEvent',
} as const);

export type ZhongkaoRuntimeKind =
  (typeof ZHONGKAO_RUNTIME_KINDS)[keyof typeof ZHONGKAO_RUNTIME_KINDS];

export type ZhongkaoLongLivedRuntimeKind =
  | typeof ZHONGKAO_RUNTIME_KINDS.studentProfile
  | typeof ZHONGKAO_RUNTIME_KINDS.studyAttempt;

const SERVER_ONLY_RUNTIME_KINDS: ReadonlySet<string> = new Set([
  ZHONGKAO_RUNTIME_KINDS.studyAttempt,
  ZHONGKAO_RUNTIME_KINDS.coachEvent,
  ZHONGKAO_RUNTIME_KINDS.examEvent,
]);

export function isServerOnlyRuntimeKind(kind: unknown): kind is string {
  return typeof kind === 'string' && SERVER_ONLY_RUNTIME_KINDS.has(kind);
}
