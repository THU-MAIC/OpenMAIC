import { HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';

/** Authentication refusals cannot recover through an automatic runtime retry. */
export function isRuntimeAuthenticationFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof HttpRuntimeStoreError && current.status === 401) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
