// @vitest-environment jsdom

/**
 * `preloadEditor` waits only for what EditShell needs registered (the slide
 * and quiz surfaces); the picker fonts load beside it and never hold the
 * Learn→Edit switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  surfaceLoads: 0,
  fontLoads: 0,
  failSurfaces: false,
  /** Never resolves unless replaced: a font stylesheet stuck on the network. */
  fonts: null as Promise<unknown> | null,
}));

/**
 * Each test gets a fresh `preload-editor` (its cache is module state) and fresh
 * chunk mocks, so a load counts once per real import and a failure can be
 * retried. The fonts factory awaits `probe.fonts`, which is how a stylesheet
 * stuck on the network is modelled.
 */
async function freshModules() {
  vi.resetModules();
  vi.doMock('@/components/edit/surfaces/slide', () => {
    probe.surfaceLoads += 1;
    if (probe.failSurfaces) throw new Error('surface chunk failed');
    return {};
  });
  vi.doMock('@/components/edit/surfaces/quiz', () => ({}));
  vi.doMock('@/app/editor-fonts', async () => {
    probe.fontLoads += 1;
    await probe.fonts;
    return {};
  });
  const preload = await import('@/lib/edit/preload-editor');
  const { enterEditMode } = await import('@/lib/edit/enter-edit-mode');
  return { ...preload, enterEditMode };
}

/** The promise's value, or 'timeout' if it is still pending after 50 ms. */
function settleSoon<T>(promise: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50))]);
}

beforeEach(() => {
  probe.surfaceLoads = 0;
  probe.fontLoads = 0;
  probe.failSurfaces = false;
  probe.fonts = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('preloadEditor', () => {
  it('lets the switch complete while the fonts stylesheet never arrives', async () => {
    probe.fonts = new Promise(() => {});
    const { preloadEditor, isEditorPreloaded, enterEditMode } = await freshModules();
    const activate = vi.fn();
    const entered = enterEditMode({
      teardown: () => Promise.resolve(),
      preload: preloadEditor,
      activate,
      onError: vi.fn(),
    });
    expect(await settleSoon(entered)).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(isEditorPreloaded()).toBe(true);
  });

  it('still requests the fonts, after the surfaces', async () => {
    const { preloadEditor } = await freshModules();
    await preloadEditor();
    await vi.waitFor(() => expect(probe.fontLoads).toBe(1));
    expect(probe.surfaceLoads).toBe(1);
  });

  it('shares one in-flight load across repeated triggers', async () => {
    const { preloadEditor } = await freshModules();
    const first = preloadEditor();
    expect(preloadEditor()).toBe(first);
    await first;
    expect(preloadEditor()).toBe(first);
    await vi.waitFor(() => expect(probe.fontLoads).toBe(1));
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

  it('does not fail the switch when the fonts fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    probe.fonts = Promise.reject(new Error('font css failed'));
    probe.fonts.catch(() => {});
    const { preloadEditor } = await freshModules();
    await expect(preloadEditor()).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fonts'), expect.any(Error)),
    );
  });
});
