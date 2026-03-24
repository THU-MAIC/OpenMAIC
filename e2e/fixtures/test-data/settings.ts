/** Default settings-storage value for e2e tests (Zustand persist v4 format) */
export function createSettingsStorage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: {
      modelId: 'gpt-4o',
      providerId: 'openai',
      agentMode: 'preset',
      selectedAgentIds: [],
      ttsEnabled: false,
      autoConfigApplied: true,
      ...overrides,
    },
    version: 2,
  });
}
