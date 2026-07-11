export interface AgentPanelVisibilityState {
  readonly agentEnabled: boolean;
  readonly hasMessages: boolean;
  readonly isRunning: boolean;
}

export function shouldRenderAgentPanel({
  agentEnabled,
  hasMessages,
  isRunning,
}: AgentPanelVisibilityState): boolean {
  return agentEnabled || hasMessages || isRunning;
}
