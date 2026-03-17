/**
 * Chat Storage - Persist chat sessions to IndexedDB
 *
 * Independent from stage/scene storage cycle.
 * Handles serialization, truncation, and batch writes.
 */

import type { ChatSession, ChatMessageMetadata, SessionStatus } from '@/lib/types/chat';
import type { UIMessage } from 'ai';
import { db, type ChatSessionRecord } from './database';

/** Maximum messages per session to avoid IndexedDB bloat */
const MAX_MESSAGES_PER_SESSION = 200;

/**
 * Save chat sessions for a stage to IndexedDB.
 * - Active sessions are saved as 'interrupted' (streaming context lost on refresh)
 * - pendingToolCalls are cleared (runtime-only state)
 * - Messages are truncated to MAX_MESSAGES_PER_SESSION
 */
export async function saveChatSessions(stageId: string, sessions: ChatSession[]): Promise<void> {
  if (!sessions || sessions.length === 0) {
    // Delete all sessions for this stage if empty
    await db.chatSessions.where('stageId').equals(stageId).delete();
    return;
  }

  const records: ChatSessionRecord[] = sessions.map((session) => ({
    id: session.id,
    stageId,
    type: session.type,
    title: session.title,
    // Mark active sessions as interrupted (streaming context lost on refresh)
    status: (session.status === 'active' ? 'interrupted' : session.status) as SessionStatus,
    // Truncate messages and strip non-serializable data
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    config: session.config,
    toolCalls: session.toolCalls,
    pendingToolCalls: [], // Clear runtime state
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sceneId: session.sceneId,
    lastActionIndex: session.lastActionIndex,
  }));

  await db.transaction('rw', db.chatSessions, async () => {
    // Delete old sessions for this stage, then bulk insert new ones
    await db.chatSessions.where('stageId').equals(stageId).delete();
    await db.chatSessions.bulkPut(records);
  });
}

/**
 * Load chat sessions for a stage from IndexedDB.
 * Returns sessions sorted by createdAt.
 */
export async function loadChatSessions(stageId: string): Promise<ChatSession[]> {
  const records = await db.chatSessions.where('stageId').equals(stageId).sortBy('createdAt');

  return records.map((record) => ({
    id: record.id,
    type: record.type,
    title: record.title,
    status: record.status,
    messages: record.messages as UIMessage<ChatMessageMetadata>[],
    config: record.config,
    toolCalls: record.toolCalls,
    pendingToolCalls: record.pendingToolCalls,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sceneId: record.sceneId,
    lastActionIndex: record.lastActionIndex,
  }));
}

/**
 * Delete all chat sessions for a stage.
 */
export async function deleteChatSessions(stageId: string): Promise<void> {
  await db.chatSessions.where('stageId').equals(stageId).delete();
}
