import { describe, expect, it } from 'vitest';
import { shouldClearDraftElementReference } from '@/components/chat/element-reference-receipt';

function response(status: number, accepted?: string) {
  return new Response(null, {
    status,
    headers: accepted ? { 'X-OpenMAIC-Element-Reference-Accepted': accepted } : undefined,
  });
}

describe('element reference receipt settlement', () => {
  it('clears only an accepted response for the same frozen selection version', () => {
    expect(shouldClearDraftElementReference(response(200, '1'), 3, 3)).toBe(true);
    expect(shouldClearDraftElementReference(response(200), 3, 3)).toBe(false);
    expect(shouldClearDraftElementReference(response(400, '1'), 3, 3)).toBe(false);
    expect(shouldClearDraftElementReference(response(200, '1'), 3, 4)).toBe(false);
    expect(shouldClearDraftElementReference(response(200, '1'), 3, undefined)).toBe(false);
  });
});
