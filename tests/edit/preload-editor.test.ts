// @vitest-environment jsdom

/**
 * `preloadEditor` loads what EditShell needs registered (the slide and quiz
 * surfaces) once, shares the in-flight load and retries after a failure. The
 * slide font picker's fonts are declared on every page by the root layout, so
 * nothing font-related waits on the editor chunk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  surfaceLoads: 0,
  failSurfaces: false,
}));

/**
 * Each test gets a fresh `preload-editor` (its cache is module state) and fresh
 * chunk mocks, so a load counts once per real import and a failure can be
 * retried.
 */
async function freshModules() {
  vi.resetModules();
  vi.doMock('@/components/edit/surfaces/slide', () => {
    probe.surfaceLoads += 1;
    if (probe.failSurfaces) throw new Error('surface chunk failed');
    return {};
  });
  vi.doMock('@/components/edit/surfaces/quiz', () => ({}));
  const preload = await import('@/lib/edit/preload-editor');
  const { enterEditMode } = await import('@/lib/edit/enter-edit-mode');
  return { ...preload, enterEditMode };
}

beforeEach(() => {
  probe.surfaceLoads = 0;
  probe.failSurfaces = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('preloadEditor', () => {
  it('completes the switch once the surfaces are registered', async () => {
    const { preloadEditor, isEditorPreloaded, enterEditMode } = await freshModules();
    const activate = vi.fn();
    const entered = await enterEditMode({
      teardown: () => Promise.resolve(),
      preload: preloadEditor,
      activate,
      onError: vi.fn(),
    });
    expect(entered).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(isEditorPreloaded()).toBe(true);
    expect(probe.surfaceLoads).toBe(1);
  });

  it('shares one in-flight load across repeated triggers', async () => {
    const { preloadEditor } = await freshModules();
    const first = preloadEditor();
    expect(preloadEditor()).toBe(first);
    await first;
    expect(preloadEditor()).toBe(first);
    expect(probe.surfaceLoads).toBe(1);
  });

  it('forgets a failed load so the next switch retries it', async () => {
    probe.failSurfaces = true;
    const { preloadEditor, isEditorPreloaded } = await freshModules();
    const failed = preloadEditor();
    await expect(failed).rejects.toThrow();
    expect(isEditorPreloaded()).toBe(false);

    probe.failSurfaces = false;
    const retried = preloadEditor();
    expect(retried).not.toBe(failed);
    await expect(retried).resolves.toBeUndefined();
    expect(isEditorPreloaded()).toBe(true);
  });
});
