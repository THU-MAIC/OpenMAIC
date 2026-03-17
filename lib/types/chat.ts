/**
 * Shared Type Definitions for Multi-Agent Orchestration
 *
 * Defines the session-based multi-agent conversation system with
 * support for QA, Discussion, and Lecture session types.
 */

import type { UIMessage } from 'ai';

// Session Types
export type SessionType = 'qa' | 'discussion' | 'lecture';
export type SessionStatus = 'idle' | 'active' | 'interrupted' | 'completed';

/**
 * Metadata attached to chat messages
 */
export interface ChatMessageMetadata {
  senderName?: string;
  senderAvatar?: string;
  originalRole?: 'teacher' | 'agent' | 'user';
  actions?: MessageAction[];
  agentId?: string;
  agentColor?: string;
  createdAt?: number;
  interrupted?: boolean;
}

/**
 * Action buttons that can be attached to messages
 */
export interface MessageAction {
  id: string;
  label: string;
  icon?: string;
  variant?: 'spotlight' | 'highlight' | 'reset' | 'insert' | 'draw';
}

/**
 * Chat session representing a conversation with one or more agents
 */
export interface ChatSession {
  id: string;
  type: SessionType;
  title: string;
  status: SessionStatus;
  messages: UIMessage<ChatMessageMetadata>[];
  config: SessionConfig;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: ToolCallRequest[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

/**
 * Session configuration
 */
export interface SessionConfig {
  agentIds: string[];
  maxTurns: number;
  currentTurn: number;
  triggerAgentId?: string; // For discussion: first agent to speak
  defaultAgentId?: string; // For QA: the responding agent
}

/**
 * Pending tool call request sent to client for execution
 */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  status: 'pending' | 'executing';
  requestedAt: number;
}

/**
 * Completed tool call record with result
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  result?: unknown;
  error?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  requestedAt: number;
  completedAt?: number;
}

/**
 * Server-Sent Event types for streaming session updates
 */
export type SessionEvent =
  | { type: 'message'; data: UIMessage<ChatMessageMetadata> }
  | {
      type: 'tool_request';
      data: { sessionId: string; toolCalls: ToolCallRequest[] };
    }
  | { type: 'tool_complete'; data: ToolCallRecord }
  | {
      type: 'agent_switch';
      data: { fromAgentId: string | null; toAgentId: string };
    }
  | { type: 'session_status'; data: { status: SessionStatus; reason?: string } }
  | { type: 'error'; data: { message: string } }
  | { type: 'done'; data: SessionSummary }
  | {
      type: 'text_start';
      data: { messageId: string; agentId: string; agentName: string };
    }
  | { type: 'text_delta'; data: { messageId: string; delta: string } }
  | { type: 'text_end'; data: { messageId: string; content: string } };

/**
 * Summary data sent when session completes
 */
export interface SessionSummary {
  sessionId: string;
  totalTurns: number;
  totalMessages: number;
  totalToolCalls: number;
  endReason: string;
}

/**
 * Request body for creating a new session
 */
export interface CreateSessionRequest {
  type: SessionType;
  title?: string;
  trigger: {
    message?: string;
    agentIds: string[];
    triggerAgentId?: string;
    maxTurns?: number;
  };
}

/**
 * Request body for sending a message to a session
 */
export interface SendMessageRequest {
  content: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  storeState: {
    stage: unknown;
    scenes: unknown[];
    currentSceneId: string | null;
    mode: 'autonomous' | 'playback';
    whiteboardOpen: boolean;
  };
}

/**
 * Request body for submitting tool results
 */
export interface ToolResultsRequest {
  results: ToolCallRecord[];
}

/**
 * Session list item (without full messages for efficiency)
 */
export interface SessionListItem {
  id: string;
  type: SessionType;
  title: string;
  status: SessionStatus;
  messageCount: number;
  toolCallCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Convert a full ChatSession to a list item (without messages)
 */
export function toSessionListItem(session: ChatSession): SessionListItem {
  return {
    id: session.id,
    type: session.type,
    title: session.title,
    status: session.status,
    messageCount: session.messages.length,
    toolCallCount: session.toolCalls.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * A single item in a lecture note — either speech text or an action badge.
 * Ordered to match the original action sequence in the scene.
 */
export type LectureNoteItem =
  | { kind: 'speech'; text: string }
  | { kind: 'action'; type: string; label?: string };

/**
 * A completed lecture note entry for one scene.
 * Built from Scene.actions, displayed in the Notes tab.
 */
export interface LectureNoteEntry {
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  items: LectureNoteItem[];
  completedAt: number;
}

// ==================== Stateless Multi-Agent API Types ====================

import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/director-prompt';

/**
 * Accumulated director state passed between per-agent requests.
 * Client-maintained — backend is stateless.
 */
export interface DirectorState {
  turnCount: number;
  agentResponses: AgentTurnSummary[];
  whiteboardLedger: WhiteboardActionRecord[];
}

/**
 * Request body for the stateless chat API
 * All state is sent from the client on each request
 */
export interface StatelessChatRequest {
  /** Conversation history (client-maintained) */
  messages: UIMessage<ChatMessageMetadata>[];
  /** Current application state */
  storeState: {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    mode: StageMode;
    whiteboardOpen: boolean;
  };
  /** Agent configuration */
  config: {
    agentIds: string[];
    sessionType?: 'qa' | 'discussion';
    /** Discussion topic (for agent-initiated discussions) */
    discussionTopic?: string;
    /** Discussion prompt (for agent-initiated discussions) */
    discussionPrompt?: string;
    /** Which agent should speak first in a discussion */
    triggerAgentId?: string;
    /** Full agent configs for generated (non-default) agents that aren't in the server-side registry */
    agentConfigs?: Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      allowedActions: string[];
      priority: number;
      isGenerated?: boolean;
      boundStageId?: string;
    }>;
  };
  /** Accumulated director state from previous per-agent requests */
  directorState?: DirectorState;
  /** User profile for personalization */
  userProfile?: {
    nickname?: string;
    bio?: string;
  };
  /** OpenAI-compatible API credentials */
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Parsed action from structured output
 */
export interface ParsedAction {
  actionId: string;
  actionName: string;
  params: Record<string, unknown>;
}

/** @deprecated Use ParsedAction instead */
export type ParsedToolCall = ParsedAction;

/**
 * Server-Sent Events for stateless chat API
 */
export type StatelessEvent =
  | {
      type: 'agent_start';
      data: {
        messageId: string;
        agentId: string;
        agentName: string;
        agentAvatar?: string;
        agentColor?: string;
      };
    }
  | { type: 'agent_end'; data: { messageId: string; agentId: string } }
  | { type: 'text_delta'; data: { content: string; messageId?: string } }
  | {
      type: 'action';
      data: {
        actionId: string;
        actionName: string;
        params: Record<string, unknown>;
        agentId: string;
        messageId?: string;
      };
    }
  | {
      type: 'thinking';
      data: { stage: 'director' | 'agent_loading'; agentId?: string };
    }
  | { type: 'cue_user'; data: { fromAgentId?: string; prompt?: string } }
  | {
      type: 'done';
      data: {
        totalActions: number;
        totalAgents: number;
        agentHadContent?: boolean;
        directorState?: DirectorState;
      };
    }
  | { type: 'error'; data: { message: string } };
