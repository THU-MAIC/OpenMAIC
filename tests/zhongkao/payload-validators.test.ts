import { describe, expect, it } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime';

import { NOW, studyAttempt } from './fixtures';

describe('zhongkao runtime payload validators', () => {
  it('validates both StudentProfile and StudyAttempt payloads', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]!(profile)).toEqual(
      {
        valid: true,
      },
    );
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!(studyAttempt()),
    ).toEqual({ valid: true });
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
});
