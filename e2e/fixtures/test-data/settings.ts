/**
 * Where the settings store lands once persisted: the `@openmaic/storage`
 * browser KVStore namespaces `<namespace>:<scope>:<key>`, and the store
 * declares the `account` scope.
 *
 * Specs still seed the bare `settings-storage` key — that is what an install
 * from before the KVStore cutover looks like, and the store adopts it on first
 * read — but anything reading a persisted value back has to look here.
 */
export const SETTINGS_KV_KEY = 'maic:account:settings-storage';

/** Default settings-storage value for e2e tests (Zustand persist v4 format) */
export function createSettingsStorage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: {
      modelId: 'gpt-4o',
      providerId: 'openai',
      providersConfig: {
        openai: { apiKey: 'test-key' },
      },
      agentMode: 'preset',
      selectedAgentIds: [],
      ttsEnabled: false,
      reviewOutlineEnabled: false,
      autoConfigApplied: true,
      ...overrides,
    },
    version: 2,
  });
}
