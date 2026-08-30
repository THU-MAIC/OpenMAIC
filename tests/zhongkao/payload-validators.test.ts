import { describe, expect, it } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { CoachStartedEvent } from '@/lib/zhongkao/coach-event';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime';

import { evaluatedStudyAttemptV2, NOW, studyAttempt, unassessedStudyAttemptV2 } from './fixtures';

describe('zhongkao runtime payload validators', () => {
  const coachEvent: CoachStartedEvent = {
    schemaVersion: 1,
    eventId: 'coach-event-alpha',
    coachSessionId: 'coach-session-alpha',
    profileId: 'student-alpha',
    eventType: 'coach_started',
    createdAt: NOW,
    agentSessionId: 'agent-chat-alpha',
    sourceUserMessageSeq: 1,
    operationId: 'coach-operation-alpha',
    operationFingerprint: 'a'.repeat(64),
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    questionText: 'Solve the fictional equation.',
  };

  it('validates StudentProfile, StudyAttempt, and CoachEvent payloads', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]!(profile)).toEqual(
      {
        valid: true,
      },
    );
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!(studyAttempt()),
    ).toEqual({ valid: true });
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.coachEvent]!(coachEvent)).toEqual({
      valid: true,
    });
  });

  it('returns stable contract errors for invalid material and profile payloads', () => {
    const material = studyAttempt({ questionSourceType: 'material' });
    const result = APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!(material);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.path).toBe('/sourceMaterialId');

    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const malformed = {
      ...profile,
      grade: { ...profile.grade, value: null },
    };
    const profileResult =
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]!(malformed);
    expect(profileResult.valid).toBe(false);
    if (!profileResult.valid) expect(profileResult.errors[0]?.path).toBe('/grade/value');
  });

  it('validates both v2 variants through the shared RuntimeStore validator', () => {
    const validator = APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!;
    expect(validator(evaluatedStudyAttemptV2())).toEqual({ valid: true });
    expect(validator(unassessedStudyAttemptV2())).toEqual({ valid: true });
    expect(validator({ ...evaluatedStudyAttemptV2(), extra: true }).valid).toBe(false);
    expect(validator({ ...unassessedStudyAttemptV2(), finalOutcome: 'correct' }).valid).toBe(false);
  });

  it('keeps all three Zhongkao runtime kinds one-to-one with their payloads', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.coachEvent]!(profile).valid).toBe(
      false,
    );
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]!(coachEvent).valid,
    ).toBe(false);
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!(coachEvent).valid,
    ).toBe(false);
  });
});
