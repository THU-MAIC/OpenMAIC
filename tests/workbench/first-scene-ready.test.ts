import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasReadableFirstScene, watchFirstScene } from '@/lib/workbench/first-scene-ready';

const manifest = { rev: 1, scenes: [{ id: 'first', order: 0, rev: 1 }] };
function respond(scenes: unknown[], currentManifest = manifest) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/manifest') ? currentManifest : { scenes }),
    })),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('first persisted scene handoff', () => {
  it('does not treat a stage shell or a manifest alone as content', async () => {
    respond([], { rev: 1, scenes: [] });
    expect(await hasReadableFirstScene('course')).toBe(false);
    respond([]);
    expect(await hasReadableFirstScene('course')).toBe(false);
  });
  it('requires the correct stage and first scene, without any audio field', async () => {
    respond([{ id: 'first', stageId: 'other' }]);
    expect(await hasReadableFirstScene('course')).toBe(false);
    respond([{ id: 'later', stageId: 'course' }]);
    expect(await hasReadableFirstScene('course')).toBe(false);
    respond([{ id: 'first', stageId: 'course' }]);
    expect(await hasReadableFirstScene('course')).toBe(true);
  });
  it('keeps a failed read closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await hasReadableFirstScene('course')).toBe(false);
  });
  it('cancels a late readable first scene after navigation', async () => {
    let resolve!: (value: unknown) => void;
    const read = vi.fn(async (url: string) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => manifest };
      return new Promise((done) => {
        resolve = done;
      });
    });
    vi.stubGlobal('fetch', read);
    const open = vi.fn();
    const cancel = watchFirstScene(['course'], open);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    cancel();
    resolve({
      ok: true,
      status: 200,
      json: async () => ({ scenes: [{ id: 'first', stageId: 'course' }] }),
    });
    await new Promise((done) => setTimeout(done, 0));
    expect(open).not.toHaveBeenCalled();
  });

  it('reads once per shell trigger and opens a readable scene once', async () => {
    vi.useFakeTimers();
    respond([{ id: 'first', stageId: 'course' }]);
    const open = vi.fn();
    const cancel = watchFirstScene(['course'], open);
    await vi.advanceTimersByTimeAsync(9000);
    expect(open).toHaveBeenCalledExactlyOnceWith('course');
    expect(fetch).toHaveBeenCalledTimes(2);
    cancel();
  });
  it('makes a final read but does not poll an ended empty shell', async () => {
    vi.useFakeTimers();
    respond([]);
    const cancel = watchFirstScene(['course'], vi.fn());
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetch).toHaveBeenCalledTimes(2);
    cancel();
  });
});
