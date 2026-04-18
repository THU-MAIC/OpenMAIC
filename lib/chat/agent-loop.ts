/**
 * Agent Loop — Shared core logic for the frontend-driven multi-agent loop.
 *
 * Extracted from use-chat-sessions.ts so both the frontend hook and the
 * eval harness share the same loop logic. No React dependency — pure
 * async function with callback injection for environment-specific behavior.
 *
 * The loop runs per-user-message: the director dispatches agents one at a
 * time, each agent generates a response, and the loop continues until the
 * director says END, cues the user, or maxTurns is reached.
 */

import type { StatelessEvent, DirectorState } from '@/lib/types/chat';
import { createLogger } from '@/lib/logger';

const log = createLogger('AgentLoop');

// ==================== Types ====================

/** Store state snapshot sent with each /api/chat request */
export interface AgentLoopStoreState {
  stage: unknown;
  scenes: unknown[];
  currentSceneId: string | null;
  mode: string;
  whiteboardOpen: boolean;
}

/** Request template — fields that stay constant across loop iterations */
export interface AgentLoopRequest {
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  userProfile?: { nickname?: string; bio?: string };
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
}

/** Per-iteration outcome extracted from the done event */
export interface AgentLoopIterationResult {
  directorState?: DirectorState;
  totalAgents: number;
  agentHadContent: boolean;
  cueUserReceived: boolean;
}

/** Callbacks injected by the caller (frontend or eval) */
export interface AgentLoopCallbacks {
  /** Get fresh store state for each iteration (whiteboard may have changed) */
  getStoreState: () => AgentLoopStoreState;

  /** Get current messages for the request */
  getMessages: () => unknown[];

  /**
   * Make the HTTP request to /api/chat.
   * Returns a Response object (or equivalent with .body ReadableStream).
   */
  fetchChat: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

  /**
   * Process a single SSE event. Called for every event in the stream.
   * The callback should handle action execution, text accumulation,
   * message construction, and UI updates.
   */
  onEvent: (event: StatelessEvent) => void;

  /**
   * Called after all SSE events for one iteration have been processed
   * and the stream is closed.
   *
   * Must return the iteration result (extracted from the 'done' event).
   * The frontend waits for buffer drain here before reading the result
   * from loopDoneDataRef. The eval harness returns a result it
   * accumulated during onEvent calls.
   */
  onIterationEnd: () => Promise<AgentLoopIterationResult | null>;
}

/** Final outcome of the agent loop */
export interface AgentLoopOutcome {
  /** Why the loop stopped */
  reason: 'end' | 'cue_user' | 'max_turns' | 'aborted' | 'empty_turns' | 'no_done';
  /** Accumulated director state */
  directorState?: DirectorState;
  /** Number of iterations completed */
  turnCount: number;
}

// ==================== Core Loop ====================

/**
 * Run the agent loop — shared between frontend and eval.
 *
 * Each iteration: refresh state → POST /api/chat → process SSE events
 * → check exit conditions → repeat.
 */
export async function runAgentLoop(
  request: AgentLoopRequest,
  callbacks: AgentLoopCallbacks,
  signal: AbortSignal,
  maxTurns: number,
): Promise<AgentLoopOutcome> {
  let directorState: DirectorState | undefined = undefined;
  let turnCount = 0;
  let consecutiveEmptyTurns = 0;

  while (turnCount < maxTurns) {
    if (signal.aborted) {
      return { reason: 'aborted', directorState, turnCount };
    }

    // Refresh store state each iteration — agent actions may have changed
    // whiteboard, scene, or mode between turns
    const freshStoreState = callbacks.getStoreState();
    const currentMessages = callbacks.getMessages();

    // Build request body
    const body: Record<string, unknown> = {
      messages: currentMessages,
      storeState: freshStoreState,
      config: request.config,
      directorState,
      userProfile: request.userProfile,
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      model: request.model,
      providerType: request.providerType,
    };

    // Fetch
    const response = await callbacks.fetchChat(body, signal);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    // Parse SSE stream and process events
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop() || '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;

          try {
            const event: StatelessEvent = JSON.parse(line.slice(6));
            callbacks.onEvent(event);
          } catch {
            // Skip malformed events (heartbeats, etc.)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (signal.aborted) {
      return { reason: 'aborted', directorState, turnCount };
    }

    // Post-iteration: wait for buffer drain (frontend) or collect results (eval)
    const iterationResult = await callbacks.onIterationEnd();

    // Check exit conditions
    if (!iterationResult) {
      return { reason: 'no_done', directorState, turnCount };
    }

    // Update accumulated director state
    directorState = iterationResult.directorState;
    turnCount = directorState?.turnCount ?? turnCount + 1;

    // Director said USER — stop loop
    if (iterationResult.cueUserReceived) {
      return { reason: 'cue_user', directorState, turnCount };
    }

    // Director said END — no agent spoke
    if (iterationResult.totalAgents === 0) {
      return { reason: 'end', directorState, turnCount };
    }

    // Track consecutive empty responses
    if (!iterationResult.agentHadContent) {
      consecutiveEmptyTurns++;
      if (consecutiveEmptyTurns >= 2) {
        log.warn(
          `[AgentLoop] ${consecutiveEmptyTurns} consecutive empty agent responses, stopping loop`,
        );
        return { reason: 'empty_turns', directorState, turnCount };
      }
    } else {
      consecutiveEmptyTurns = 0;
    }
  }

  // maxTurns reached
  if (turnCount >= maxTurns) {
    log.info(`[AgentLoop] Max turns (${maxTurns}) reached`);
  }
  return { reason: 'max_turns', directorState, turnCount };
}
