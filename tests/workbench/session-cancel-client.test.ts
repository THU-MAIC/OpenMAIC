import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelWorkbenchSession,
  recoverTerminalCancelStatus,
  terminalStatusFromCancelError,
  useWorkbenchStore,
  WorkbenchApiError,
} from '@/lib/workbench/session-store';

afterEach(() => {
  vi.unstubAllGlobals();
  useWorkbenchStore.getState().detach();
});

describe('cancelWorkbenchSession terminal conflict recovery', () => {
  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'preserves 409 and recognizes an already-%s session',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: 'SESSION_ALREADY_TERMINAL',
                status,
                error: 'copy may change without breaking recovery',
              }),
              { status: 409 },
            ),
        ),
      );

      const error = await cancelWorkbenchSession('session-1').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkbenchApiError);
      expect(error).toMatchObject({
        status: 409,
        errorCode: 'SESSION_ALREADY_TERMINAL',
        terminalStatus: status,
      });
      expect(terminalStatusFromCancelError(error)).toBe(status);
    },
  );

  it('does not treat other failures or unknown conflicts as terminal', () => {
    expect(terminalStatusFromCancelError(new WorkbenchApiError('gateway timeout', 503))).toBeNull();
    expect(terminalStatusFromCancelError(new WorkbenchApiError('conflict', 409))).toBeNull();
    expect(
      terminalStatusFromCancelError(
        new WorkbenchApiError('session is already succeeded', 409, 'A_DIFFERENT_CONFLICT'),
      ),
    ).toBeNull();
    expect(terminalStatusFromCancelError(new Error('session is already succeeded'))).toBeNull();
  });

  it('falls back to the legacy 409 message when the structured code is absent', () => {
    expect(
      terminalStatusFromCancelError(new WorkbenchApiError('session is already cancelled', 409)),
    ).toBe('cancelled');
  });

  it('does not let a late conflict from session A overwrite attached session B', () => {
    useWorkbenchStore.getState().attach('session-a', 'stage-a');
    useWorkbenchStore.setState({ status: 'running' });
    useWorkbenchStore.getState().attach('session-b', 'stage-b');
    useWorkbenchStore.setState({ status: 'running' });

    const lateA = new WorkbenchApiError(
      'session is already succeeded',
      409,
      'SESSION_ALREADY_TERMINAL',
      'succeeded',
    );
    expect(recoverTerminalCancelStatus('session-a', lateA)).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionId: 'session-b',
      status: 'running',
    });
  });

  it('recovers the attached session without inventing an event id', () => {
    useWorkbenchStore.getState().attach('session-a', 'stage-a');
    useWorkbenchStore.setState({ status: 'running', lastEventId: 41 });
    const conflict = new WorkbenchApiError(
      'changed copy',
      409,
      'SESSION_ALREADY_TERMINAL',
      'failed',
    );
    expect(recoverTerminalCancelStatus('session-a', conflict)).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionId: 'session-a',
      status: 'failed',
      lastEventId: 41,
    });
  });
});
