/**
 * Request keys (`e<event id>`) and the node keys inside a request come from a
 * conversation's own event sequence, so two conversations reuse the same
 * keys. Anything remembered about a request or one of its nodes is
 * remembered with its conversation: this is the one composite key for that.
 */
export function sessionScopedKey(sessionId: string | null, key: string): string {
  return `${sessionId ?? ''}\u0000${key}`;
}
