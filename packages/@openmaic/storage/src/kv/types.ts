/**
 * KV scope. `account` values are user/account data that a server-backed
 * deployment syncs across devices (provider/model config, profile). `device`
 * values are machine-local UI state (theme, locale, layout) that must never
 * leave the device — every backend honours that, so a `device` write stays
 * local even when `account` writes go to a server.
 */
export type KVScope = 'device' | 'account';

/**
 * Small keyed values not owned by the DSL. The scope defaults to `account`;
 * pass `device` for machine-local preferences. Values must be JSON-serializable
 * — the store owns (de)serialization so callers pass and receive plain values.
 */
export interface KVStore {
  get<T>(key: string, scope?: KVScope): Promise<T | null>;
  set<T>(key: string, value: T, scope?: KVScope): Promise<void>;
  remove(key: string, scope?: KVScope): Promise<void>;
  keys(prefix?: string, scope?: KVScope): Promise<string[]>;
}

/** The default scope used when a caller omits one. */
export const DEFAULT_KV_SCOPE: KVScope = 'account';
