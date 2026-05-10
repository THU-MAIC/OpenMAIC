/**
 * Tests for the generation-preview stop handler.
 *
 * The generation-preview page does not use the `useSceneGenerator` hook
 * because outline generation runs inline (the hook only owns scene
 * content + actions + TTS, after redirect to /classroom). It manages
 * its own AbortController, so it needs its own stop entry point.
 *
 * These tests pin the three required side effects of pressing
 * "Stop generation" on this page: abort the controller, clear the
 * session, fire a toast, push home.
 */
import { describe, expect, it, vi } from 'vitest';
import { runStopGeneration } from '@/app/generation-preview/stop-generation';

function makeDeps(overrides: Partial<Parameters<typeof runStopGeneration>[0]> = {}) {
  const controller = new AbortController();
  const abortSpy = vi.spyOn(controller, 'abort');
  const clearSession = vi.fn();
  const toast = vi.fn();
  const pushHome = vi.fn();
  const t = vi.fn((key: string) => key);
  return {
    deps: {
      abortControllerRef: { current: controller },
      clearSession,
      toast,
      pushHome,
      t,
      ...overrides,
    },
    controller,
    abortSpy,
    clearSession,
    toast,
    pushHome,
    t,
  };
}

describe('runStopGeneration (generation-preview)', () => {
  it('aborts the in-flight controller, clears session, toasts, and pushes home', () => {
    const { deps, abortSpy, clearSession, toast, pushHome, t } = makeDeps();

    runStopGeneration(deps);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(pushHome).toHaveBeenCalledTimes(1);
    // toast text comes via t() so layouts stay i18n-compliant
    expect(t).toHaveBeenCalledWith('generation.stopGenerationToast');
    expect(toast).toHaveBeenCalledWith('generation.stopGenerationToast');
  });

  it('still toasts and pushes home when no controller is registered', () => {
    const { deps, toast, pushHome, clearSession } = makeDeps();
    deps.abortControllerRef.current = null;

    runStopGeneration(deps);

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(pushHome).toHaveBeenCalledTimes(1);
  });

  it('runs side effects in a deterministic order (abort → clear → toast → push)', () => {
    const calls: string[] = [];
    const controller = new AbortController();
    vi.spyOn(controller, 'abort').mockImplementation(() => {
      calls.push('abort');
    });
    const deps = {
      abortControllerRef: { current: controller },
      clearSession: () => calls.push('clearSession'),
      toast: () => calls.push('toast'),
      pushHome: () => calls.push('pushHome'),
      t: (key: string) => key,
    };

    runStopGeneration(deps);

    expect(calls).toEqual(['abort', 'clearSession', 'toast', 'pushHome']);
  });
});
