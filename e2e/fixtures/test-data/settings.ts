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

/**
 * Default settings-storage value for e2e tests (Zustand persist v6 format):
 * the user's own preferences. Models and providers are the workspace's,
 * answered by `/api/model-config` (see ./model-settings.ts).
 */
export function createSettingsStorage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: {
      agentMode: 'preset',
      selectedAgentIds: [],
      reviewOutlineEnabled: false,
      ...overrides,
    },
    version: 6,
  });
}
