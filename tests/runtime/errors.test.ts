import { describe, expect, it } from 'vitest';
import { HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';

import { isRuntimeAuthenticationFailure } from '@/lib/runtime/errors';

describe('isRuntimeAuthenticationFailure', () => {
  it('finds a runtime 401 through nested chat error causes', () => {
    const refusal = new HttpRuntimeStoreError(401, 'UNAUTHORIZED', 'Authentication required');
    const error = new Error('Save failed', {
      cause: new Error('Chat sync rejected', { cause: refusal }),
    });

    expect(isRuntimeAuthenticationFailure(refusal)).toBe(true);
    expect(isRuntimeAuthenticationFailure(error)).toBe(true);
  });

  it.each([400, 403, 429, 503])('does not block a runtime HTTP %i as a 401 refusal', (status) => {
    expect(
      isRuntimeAuthenticationFailure(new HttpRuntimeStoreError(status, 'HTTP_ERROR', 'Failed')),
    ).toBe(false);
  });

  it('does not classify an unrelated error or text as a runtime authentication refusal', () => {
    expect(isRuntimeAuthenticationFailure(new Error('HTTP 401'))).toBe(false);
    expect(isRuntimeAuthenticationFailure('HTTP 401')).toBe(false);
    expect(isRuntimeAuthenticationFailure(undefined)).toBe(false);
  });

  it('terminates when an error cause chain is cyclic', () => {
    const error = new Error('Runtime unavailable');
    error.cause = error;

    expect(isRuntimeAuthenticationFailure(error)).toBe(false);
  });
});
