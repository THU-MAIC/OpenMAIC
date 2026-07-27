/**
 * Account namespaces use a SHA-256 prefix, never a raw Supabase user id.
 *
 * 32 hex characters = 128 bits. Even with 100,000 accounts the birthday-bound
 * collision probability is about 1.5e-29, so it is negligible for an IndexedDB
 * isolation boundary while keeping database names short.
 */
export const ACCOUNT_NAMESPACE_HEX_LENGTH = 32;

export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SubtleCrypto is unavailable');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function accountNamespace(userId: string): Promise<string> {
  if (!userId) throw new Error('Missing authenticated user id');
  return (await sha256Hex(userId)).slice(0, ACCOUNT_NAMESPACE_HEX_LENGTH);
}
