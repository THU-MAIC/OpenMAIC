/**
 * POST /api/interactions — record courseware interaction facts.
 *
 * The only identity honored is the SSO session cookie; the client-supplied
 * payload is validated per `type` and capped so a hostile or buggy browser
 * cannot balloon the tables. Recording is fire-and-forget on the client side
 * (keepalive fetch), so this route answers fast and is idempotent per event.
 *
 * Body:
 *  {
 *    type: 'quiz_answer' | 'chat_message' | 'view_event',
 *    stageId: string,   // the classroom id
 *    data: {
 *      // quiz_answer
 *      sceneId?, questionId?, question?, userAnswer?, isCorrect?, score?,
 *      maxScore?, attemptId?,
 *      // chat_message
 *      role: 'user' | 'assistant' | 'system', content: string,
 *      chatSessionId?, sceneId?,
 *      // view_event
 *      event: string, sceneId?
 *    }
 *  }
 */

import type { NextRequest } from 'next/server';

import {
  recordChatMessage,
  recordQuizAnswer,
  recordViewEvent,
} from '@/lib/persistence/user-interactions';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getRequestUser } from '@/lib/server/auth/request-user';
import { createLogger } from '@/lib/logger';

const log = createLogger('Interactions API');

const MAX_STAGE_ID_LENGTH = 128;
const MAX_QUESTION_LENGTH = 20_000;
const MAX_ANSWER_LENGTH = 50_000;
const MAX_CHAT_CONTENT_LENGTH = 100_000;
const MAX_EVENT_NAME_LENGTH = 64;

const STAGE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

type InteractionType = 'quiz_answer' | 'chat_message' | 'view_event';

function isRecord(record: unknown): record is Record<string, unknown> {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record);
}

function optionalTrimmed(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export async function POST(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) {
    return apiError('UNAUTHENTICATED', 401, 'Login required to record interactions');
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return apiError('SSO_NOT_CONFIGURED', 503, 'Database is not configured');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Body must be JSON');
  }
  if (!isRecord(body)) return apiError('INVALID_REQUEST', 400, 'Body must be an object');

  const type = body.type;
  if (type !== 'quiz_answer' && type !== 'chat_message' && type !== 'view_event') {
    return apiError('INVALID_REQUEST', 400, 'Unsupported interaction type');
  }
  const interactionType = type as InteractionType;

  const stageId = optionalTrimmed(body.stageId, MAX_STAGE_ID_LENGTH);
  if (!stageId || !STAGE_ID_PATTERN.test(stageId)) {
    return apiError('INVALID_REQUEST', 400, 'stageId is required and must be a classroom id');
  }

  if (!isRecord(body.data)) {
    return apiError('INVALID_REQUEST', 400, 'data must be an object');
  }
  const data = body.data;

  try {
    const { pool } = await getServerPersistenceProvider(connectionString);
    let id: string;

    switch (interactionType) {
      case 'quiz_answer': {
        id = await recordQuizAnswer(pool, {
          userId: user.id,
          stageId,
          sceneId: optionalTrimmed(data.sceneId, 256),
          questionId: optionalTrimmed(data.questionId, 256),
          question: optionalTrimmed(data.question, MAX_QUESTION_LENGTH),
          userAnswer: optionalTrimmed(data.userAnswer, MAX_ANSWER_LENGTH),
          isCorrect: optionalBoolean(data.isCorrect),
          score: optionalNumber(data.score),
          maxScore: optionalNumber(data.maxScore),
          attemptId: optionalTrimmed(data.attemptId, 256),
        });
        break;
      }
      case 'chat_message': {
        const role = optionalTrimmed(data.role, 16);
        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
          return apiError(
            'INVALID_REQUEST',
            400,
            'chat_message data.role must be user/assistant/system',
          );
        }
        const content = optionalTrimmed(data.content, MAX_CHAT_CONTENT_LENGTH);
        if (content === null) {
          return apiError('INVALID_REQUEST', 400, 'chat_message data.content is required');
        }
        id = await recordChatMessage(pool, {
          userId: user.id,
          stageId,
          role,
          content,
          chatSessionId: optionalTrimmed(data.chatSessionId, 256),
          sceneId: optionalTrimmed(data.sceneId, 256),
        });
        break;
      }
      case 'view_event': {
        const event = optionalTrimmed(data.event, MAX_EVENT_NAME_LENGTH);
        if (!event || !/^[a-z_]+$/.test(event)) {
          return apiError(
            'INVALID_REQUEST',
            400,
            'view_event data.event must be a snake_case name',
          );
        }
        id = await recordViewEvent(pool, {
          userId: user.id,
          stageId,
          event,
          sceneId: optionalTrimmed(data.sceneId, 256),
        });
        break;
      }
    }

    return apiSuccess({ id }, 201);
  } catch (error) {
    log.error('Failed to record interaction:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to record interaction');
  }
}
