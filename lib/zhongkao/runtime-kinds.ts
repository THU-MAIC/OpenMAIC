export const ZHONGKAO_RUNTIME_KINDS = Object.freeze({
  studentProfile: 'zhongkaoStudentProfile',
  studyAttempt: 'zhongkaoStudyAttempt',
} as const);

export type ZhongkaoRuntimeKind =
  (typeof ZHONGKAO_RUNTIME_KINDS)[keyof typeof ZHONGKAO_RUNTIME_KINDS];
