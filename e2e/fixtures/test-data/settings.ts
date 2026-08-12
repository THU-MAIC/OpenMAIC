/**
 * Where the settings store lands once persisted: the `@openmaic/storage`
 * browser KVStore namespaces `<namespace>:<scope>:<key>`, and the store
 * declares the `account` scope.
 *
 * Specs seed this key to give the store a pre-existing value. The store reads
 * only the KV scope — legacy `localStorage` keys are never read or migrated —
 * so both seeding and reading a persisted value back go through this key.
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
