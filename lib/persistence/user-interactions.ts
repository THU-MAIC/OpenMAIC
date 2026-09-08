/**
 * Per-user interaction recording for courseware viewing.
 *
 * Three append-only tables hold the facts teachers/operators care about:
 *
 *  - `user_quiz_answers`   — one row per graded question of a quiz submission
 *  - `user_chat_messages`  — user and assistant turns of classroom chat
 *  - `user_view_events`    — enter/exit and similar viewing lifecycle facts
 *
 * All rows are keyed on the SSO account (`user_id`) plus the classroom id
 * (`stage_id`), never on client-supplied identity: the API route resolves the
 * user from the session cookie and ignores anything the browser claims.
 */

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { randomUUID } from 'crypto';

export const USER_INTERACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_quiz_answers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  scene_id TEXT,
  question_id TEXT,
  question TEXT,
  user_answer TEXT,
  is_correct BOOLEAN,
  score DOUBLE PRECISION,
  max_score DOUBLE PRECISION,
  attempt_id TEXT,
  answered_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS user_quiz_answers_stage_idx
  ON user_quiz_answers (stage_id, answered_at);

CREATE INDEX IF NOT EXISTS user_quiz_answers_user_idx
  ON user_quiz_answers (user_id, answered_at);

CREATE TABLE IF NOT EXISTS user_chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  chat_session_id TEXT,
  scene_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS user_chat_messages_stage_idx
  ON user_chat_messages (stage_id, created_at);

CREATE INDEX IF NOT EXISTS user_chat_messages_user_idx
  ON user_chat_messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS user_view_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  scene_id TEXT,
  event TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS user_view_events_stage_idx
  ON user_view_events (stage_id, created_at);

CREATE INDEX IF NOT EXISTS user_view_events_user_idx
  ON user_view_events (user_id, created_at);
`;

export async function ensureUserInteractionsSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(USER_INTERACTIONS_SCHEMA)) {
    await queryable.query(statement);
  }
}

export interface QuizAnswerRecordInput {
  userId: string;
  stageId: string;
  sceneId?: string | null;
  questionId?: string | null;
  question?: string | null;
  userAnswer?: string | null;
  isCorrect?: boolean | null;
  score?: number | null;
  maxScore?: number | null;
  attemptId?: string | null;
  answeredAt?: number;
}

export interface ChatMessageRecordInput {
  userId: string;
  stageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  chatSessionId?: string | null;
  sceneId?: string | null;
  createdAt?: number;
}

export interface ViewEventRecordInput {
  userId: string;
  stageId: string;
  event: string;
  sceneId?: string | null;
  createdAt?: number;
}

export async function recordQuizAnswer(
  queryable: Queryable,
  input: QuizAnswerRecordInput,
): Promise<string> {
  const id = randomUUID();
  await queryable.query(
    `INSERT INTO user_quiz_answers
       (id, user_id, stage_id, scene_id, question_id, question, user_answer,
        is_correct, score, max_score, attempt_id, answered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      input.userId,
      input.stageId,
      input.sceneId ?? null,
      input.questionId ?? null,
      input.question ?? null,
      input.userAnswer ?? null,
      input.isCorrect ?? null,
      input.score ?? null,
      input.maxScore ?? null,
      input.attemptId ?? null,
      input.answeredAt ?? Date.now(),
    ],
  );
  return id;
}

export async function recordChatMessage(
  queryable: Queryable,
  input: ChatMessageRecordInput,
): Promise<string> {
  const id = randomUUID();
  await queryable.query(
    `INSERT INTO user_chat_messages
       (id, user_id, stage_id, chat_session_id, scene_id, role, content, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.userId,
      input.stageId,
      input.chatSessionId ?? null,
      input.sceneId ?? null,
      input.role,
      input.content,
      input.createdAt ?? Date.now(),
    ],
  );
  return id;
}

export async function recordViewEvent(
  queryable: Queryable,
  input: ViewEventRecordInput,
): Promise<string> {
  const id = randomUUID();
  await queryable.query(
    `INSERT INTO user_view_events (id, user_id, stage_id, scene_id, event, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.userId,
      input.stageId,
      input.sceneId ?? null,
      input.event,
      input.createdAt ?? Date.now(),
    ],
  );
  return id;
}

// ─── Read side (analytics; no HTTP endpoint yet) ─────────────────────────────

export interface QuizAnswerRecord {
  id: string;
  userId: string;
  stageId: string;
  sceneId: string | null;
  questionId: string | null;
  question: string | null;
  userAnswer: string | null;
  isCorrect: boolean | null;
  score: number | null;
  maxScore: number | null;
  attemptId: string | null;
  answeredAt: number;
}

interface RawQuizAnswerRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  stage_id: string;
  scene_id: string | null;
  question_id: string | null;
  question: string | null;
  user_answer: string | null;
  is_correct: boolean | null;
  score: number | string | null;
  max_score: number | string | null;
  attempt_id: string | null;
  answered_at: number | string;
}

function rowToQuizAnswer(row: RawQuizAnswerRow): QuizAnswerRecord {
  return {
    id: row.id,
    userId: row.user_id,
    stageId: row.stage_id,
    sceneId: row.scene_id,
    questionId: row.question_id,
    question: row.question,
    userAnswer: row.user_answer,
    isCorrect: row.is_correct === true ? true : row.is_correct === false ? false : null,
    score: row.score === null ? null : Number(row.score),
    maxScore: row.max_score === null ? null : Number(row.max_score),
    attemptId: row.attempt_id,
    answeredAt: Number(row.answered_at),
  };
}

export async function listQuizAnswersByStage(
  queryable: Queryable,
  stageId: string,
  limit = 1000,
): Promise<QuizAnswerRecord[]> {
  const result = await queryable.query<RawQuizAnswerRow>(
    `SELECT id, user_id, stage_id, scene_id, question_id, question, user_answer,
            is_correct, score, max_score, attempt_id, answered_at
       FROM user_quiz_answers
      WHERE stage_id = $1
      ORDER BY answered_at DESC
      LIMIT $2`,
    [stageId, limit],
  );
  return result.rows.map(rowToQuizAnswer);
}

export async function listQuizAnswersByUser(
  queryable: Queryable,
  userId: string,
  limit = 1000,
): Promise<QuizAnswerRecord[]> {
  const result = await queryable.query<RawQuizAnswerRow>(
    `SELECT id, user_id, stage_id, scene_id, question_id, question, user_answer,
            is_correct, score, max_score, attempt_id, answered_at
       FROM user_quiz_answers
      WHERE user_id = $1
      ORDER BY answered_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(rowToQuizAnswer);
}
