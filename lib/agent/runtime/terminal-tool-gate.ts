import type { Tool as PiTool, ToolCall } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';

/**
 * A server-owned, run-local policy for turns whose only valid model action is
 * one specific tool call. Callers must pass the same gate instance to the
 * stream adapter and to `buildAgent`.
 */
export interface TerminalToolGatePolicy {
  requiredToolName: string;
  suppressAssistantTextBeforeTool: boolean;
  terminalAfterTool: boolean;
}

export const TERMINAL_TOOL_GATE_SIGNAL = {
  requiredToolUnavailable: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_UNAVAILABLE',
  requiredToolMissing: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_MISSING',
  unexpectedToolCall: 'TERMINAL_TOOL_GATE_UNEXPECTED_TOOL_CALL',
  invalidRequiredToolArguments: 'TERMINAL_TOOL_GATE_INVALID_REQUIRED_TOOL_ARGUMENTS',
  duplicateRequiredToolCall: 'TERMINAL_TOOL_GATE_DUPLICATE_REQUIRED_TOOL_CALL',
  requiredToolStreamIncomplete: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_STREAM_INCOMPLETE',
  requiredToolStreamFailed: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_STREAM_FAILED',
  requiredToolStreamAborted: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_STREAM_ABORTED',
  requiredToolAfterHookFailed: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_AFTER_HOOK_FAILED',
  requiredToolNotExecuted: 'TERMINAL_TOOL_GATE_REQUIRED_TOOL_NOT_EXECUTED',
} as const;

export type TerminalToolGateSignalCode =
  (typeof TERMINAL_TOOL_GATE_SIGNAL)[keyof typeof TERMINAL_TOOL_GATE_SIGNAL];

export interface TerminalToolGateSignal {
  kind: 'terminal_tool_gate';
  code: TerminalToolGateSignalCode;
  requiredToolName: string;
  observedToolName?: string;
  toolCallId?: string;
}

export type TerminalToolGateSnapshot =
  | { status: 'waiting'; requiredToolName: string }
  | { status: 'accepted'; requiredToolName: string; toolCallId: string }
  | {
      status: 'completed';
      requiredToolName: string;
      toolCallId: string;
      isError: boolean;
    }
  | { status: 'blocked'; requiredToolName: string; signal: TerminalToolGateSignal };

/** Opaque run-local gate. Its mutable state is kept outside the public object. */
export type TerminalToolGate = Readonly<TerminalToolGatePolicy>;

type GateState =
  | { status: 'waiting' }
  | { status: 'accepted'; toolCallId: string }
  | { status: 'completed'; toolCallId: string; isError: boolean }
  | { status: 'blocked'; signal: TerminalToolGateSignal };

const gateStates = new WeakMap<TerminalToolGate, GateState>();

export function createTerminalToolGate(policy: TerminalToolGatePolicy): TerminalToolGate {
  const requiredToolName = policy.requiredToolName.trim();
  if (!requiredToolName || requiredToolName !== policy.requiredToolName) {
    throw new Error('Terminal tool gate requires an exact, non-empty tool name.');
  }

  const gate = Object.freeze({
    requiredToolName,
    suppressAssistantTextBeforeTool: policy.suppressAssistantTextBeforeTool === true,
    terminalAfterTool: policy.terminalAfterTool === true,
  });
  gateStates.set(gate, { status: 'waiting' });
  return gate;
}

export function getTerminalToolGateSnapshot(gate: TerminalToolGate): TerminalToolGateSnapshot {
  const state = stateFor(gate);
  switch (state.status) {
    case 'waiting':
      return { status: 'waiting', requiredToolName: gate.requiredToolName };
    case 'accepted':
      return {
        status: 'accepted',
        requiredToolName: gate.requiredToolName,
        toolCallId: state.toolCallId,
      };
    case 'completed':
      return {
        status: 'completed',
        requiredToolName: gate.requiredToolName,
        toolCallId: state.toolCallId,
        isError: state.isError,
      };
    case 'blocked':
      return {
        status: 'blocked',
        requiredToolName: gate.requiredToolName,
        signal: { ...state.signal },
      };
  }
}

/** @internal Used by the stream adapter before exposing a parsed tool call to Pi. */
export function acceptTerminalToolGateCall(
  gate: TerminalToolGate,
  toolCall: ToolCall,
  tools: readonly PiTool[],
): boolean {
  const state = stateFor(gate);
  if (state.status === 'blocked' || state.status === 'completed') return false;
  if (state.status === 'accepted') {
    blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.duplicateRequiredToolCall, {
      toolCallId: toolCall.id,
      observedToolName: toolCall.name,
    });
    return false;
  }
  if (toolCall.name !== gate.requiredToolName) {
    blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.unexpectedToolCall, {
      toolCallId: toolCall.id,
      observedToolName: toolCall.name,
    });
    return false;
  }

  const tool = tools.find((candidate) => candidate.name === gate.requiredToolName);
  if (!tool) {
    blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolUnavailable, {
      toolCallId: toolCall.id,
    });
    return false;
  }
  try {
    validateToolArguments(tool, toolCall);
  } catch {
    blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.invalidRequiredToolArguments, {
      toolCallId: toolCall.id,
    });
    return false;
  }

  gateStates.set(gate, { status: 'accepted', toolCallId: toolCall.id });
  return true;
}

/** @internal Mark a construction-time capability mismatch without throwing model-visible data. */
export function markTerminalToolGateUnavailable(gate: TerminalToolGate): void {
  blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolUnavailable);
}

/** @internal Mark a response that ended without the required call. */
export function markTerminalToolGateMissing(gate: TerminalToolGate): void {
  if (stateFor(gate).status !== 'waiting') return;
  blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolMissing);
}

/** @internal A parsed call cannot execute when its provider response was truncated. */
export function markTerminalToolGateStreamIncomplete(gate: TerminalToolGate): void {
  const state = stateFor(gate);
  blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolStreamIncomplete, {
    ...(state.status === 'accepted' ? { toolCallId: state.toolCallId } : {}),
  });
}

/** @internal A provider failure is represented by a stable signal, never by its raw error. */
export function markTerminalToolGateStreamFailed(
  gate: TerminalToolGate,
  reason: 'error' | 'aborted',
): void {
  const state = stateFor(gate);
  blockGate(
    gate,
    reason === 'aborted'
      ? TERMINAL_TOOL_GATE_SIGNAL.requiredToolStreamAborted
      : TERMINAL_TOOL_GATE_SIGNAL.requiredToolStreamFailed,
    state.status === 'accepted' ? { toolCallId: state.toolCallId } : undefined,
  );
}

/** @internal Called only after Pi has finalized the required tool execution. */
export function completeTerminalToolGateCall(
  gate: TerminalToolGate,
  toolCallId: string,
  isError: boolean,
): boolean {
  const state = stateFor(gate);
  if (state.status !== 'accepted' || state.toolCallId !== toolCallId) {
    if (state.status === 'waiting' || state.status === 'accepted') {
      blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolNotExecuted, { toolCallId });
    }
    return false;
  }
  gateStates.set(gate, { status: 'completed', toolCallId, isError });
  return true;
}

/** @internal Keep a caller hook failure terminal without exposing the exception. */
export function markTerminalToolGateAfterHookFailed(
  gate: TerminalToolGate,
  toolCallId: string,
): void {
  blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolAfterHookFailed, { toolCallId });
}

/** @internal A matching call reached Pi but failed before its execution hook. */
export function markTerminalToolGateNotExecuted(gate: TerminalToolGate): void {
  const state = stateFor(gate);
  if (state.status !== 'accepted') return;
  blockGate(gate, TERMINAL_TOOL_GATE_SIGNAL.requiredToolNotExecuted, {
    toolCallId: state.toolCallId,
  });
}

/** @internal Defensive name check used by the build-agent allowlist composition. */
export function terminalToolGateAllowsTool(gate: TerminalToolGate, toolName: string): boolean {
  return toolName === gate.requiredToolName && stateFor(gate).status !== 'blocked';
}

function stateFor(gate: TerminalToolGate): GateState {
  const state = gateStates.get(gate);
  if (!state) throw new Error('Terminal tool gate must be created by createTerminalToolGate().');
  return state;
}

function blockGate(
  gate: TerminalToolGate,
  code: TerminalToolGateSignalCode,
  detail: Pick<TerminalToolGateSignal, 'observedToolName' | 'toolCallId'> = {},
): void {
  const current = stateFor(gate);
  if (current.status === 'blocked' || current.status === 'completed') return;
  const signal = Object.freeze({
    kind: 'terminal_tool_gate' as const,
    code,
    requiredToolName: gate.requiredToolName,
    ...detail,
  });
  gateStates.set(gate, { status: 'blocked', signal });
}
