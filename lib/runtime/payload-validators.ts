import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@openmaic/dsl';
import type { RuntimePayloadValidator } from '@openmaic/storage';

import { whiteboardRuntimePayloadValidator } from '@/lib/whiteboard/runtime/validate';
import { isValidCueUserState, isValidDirectorState } from './chat-session-state-validator';

const chat: RuntimePayloadValidator = (payload) => {
  if (!isChatMessageSkeleton(payload)) {
    return {
      valid: false,
      errors: [
        {
          path: '/payload',
          message: 'chat payload must match ChatMessageSkeleton (role + content)',
        },
      ],
    };
  }
  const state = payload as { kind?: unknown; cueUser?: unknown; directorState?: unknown };
  if (state.kind === 'chat_session_state') {
    if (state.cueUser !== undefined && !isValidCueUserState(state.cueUser)) {
      return {
        valid: false,
        errors: [{ path: '/payload/cueUser', message: 'invalid or oversized chat session cue' }],
      };
    }
    if (state.directorState !== undefined && !isValidDirectorState(state.directorState)) {
      return {
        valid: false,
        errors: [
          { path: '/payload/directorState', message: 'invalid or oversized chat director state' },
        ],
      };
    }
  }
  return { valid: true };
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

/** Complete app validator table. RuntimeStore options replace their defaults. */
export const APP_RUNTIME_PAYLOAD_VALIDATORS = Object.freeze({
  chat,
  quizAttempt,
  whiteboard: whiteboardRuntimePayloadValidator,
}) satisfies Readonly<Record<string, RuntimePayloadValidator>>;
