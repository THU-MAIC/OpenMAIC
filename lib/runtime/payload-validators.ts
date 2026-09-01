import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@openmaic/dsl';
import type { RuntimePayloadValidator } from '@openmaic/storage';

import { whiteboardRuntimePayloadValidator } from '@/lib/whiteboard/runtime/validate';
import { validateCoachEvent } from '@/lib/zhongkao/coach-event';
import { validateExamEvent } from '@/lib/zhongkao/exam-event';
import { validateStudentProfile } from '@/lib/zhongkao/profile';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import { validateStudyAttempt } from '@/lib/zhongkao/study-attempt';

const chat: RuntimePayloadValidator = (payload) =>
  isChatMessageSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'chat payload must match ChatMessageSkeleton (role + content)',
          },
        ],
      };

const quizAttempt: RuntimePayloadValidator = (payload) =>
  isQuizAttemptSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
          },
        ],
      };

const zhongkaoStudentProfile: RuntimePayloadValidator = (payload) =>
  validateStudentProfile(payload);

const zhongkaoStudyAttempt: RuntimePayloadValidator = (payload) => validateStudyAttempt(payload);

const zhongkaoCoachEvent: RuntimePayloadValidator = (payload) => validateCoachEvent(payload);

const zhongkaoExamEvent: RuntimePayloadValidator = (payload) => validateExamEvent(payload);

/** Complete app validator table. RuntimeStore options replace their defaults. */
export const APP_RUNTIME_PAYLOAD_VALIDATORS = Object.freeze({
  chat,
  quizAttempt,
  whiteboard: whiteboardRuntimePayloadValidator,
  [ZHONGKAO_RUNTIME_KINDS.studentProfile]: zhongkaoStudentProfile,
  [ZHONGKAO_RUNTIME_KINDS.studyAttempt]: zhongkaoStudyAttempt,
  [ZHONGKAO_RUNTIME_KINDS.coachEvent]: zhongkaoCoachEvent,
  [ZHONGKAO_RUNTIME_KINDS.examEvent]: zhongkaoExamEvent,
}) satisfies Readonly<Record<string, RuntimePayloadValidator>>;
