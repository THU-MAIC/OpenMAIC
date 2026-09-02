// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCoalescedLatestLoader,
  useGeneratedCourseDiscoverySync,
} from '@/lib/workbench/course-discovery-sync';
import type { SessionStatus } from '@/lib/workbench/session-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rejected(error: unknown) {
  return Promise.reject(error);
}

function RefreshHarness(props: {
  sessionId: string | null;
  stageId: string | null;
  pageCount: number;
  status: SessionStatus;
  libraryRevision?: number;
  reload: () => void;
}) {
  useGeneratedCourseDiscoverySync(props);
  return null;
}

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('generated course discovery production sync', () => {
  it('refreshes on the first durable page and the terminal edge, but not between pages', async () => {
    const reload = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const render = async (pageCount: number, status: SessionStatus) => {
      await act(async () =>
        root?.render(
          createElement(RefreshHarness, {
            sessionId: 'session-1',
            stageId: 'stage-1',
            pageCount,
            status,
            reload,
          }),
        ),
      );
    };

    await render(0, 'running');
    expect(reload).not.toHaveBeenCalled();

    await render(1, 'running');
    expect(reload).toHaveBeenCalledTimes(1);

    await render(2, 'running');
    await render(3, 'running');
    expect(reload).toHaveBeenCalledTimes(1);

    await render(3, 'succeeded');
    expect(reload).toHaveBeenCalledTimes(2);

    await render(3, 'succeeded');
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping requests and never commits the superseded snapshot', async () => {
    const oldRequest = deferred<string>();
    const latestRequest = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(latestRequest.promise);
    const commit = vi.fn();
    const fail = vi.fn();
    const reload = createCoalescedLatestLoader({ load, commit, fail });

    const first = reload();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    const second = reload();

    oldRequest.resolve('old');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(commit).not.toHaveBeenCalled();

    latestRequest.resolve('latest');
    await Promise.all([first, second]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith('latest');
    expect(fail).not.toHaveBeenCalled();
  });

  it('recovers with a fresh request after the latest load fails', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(rejected(new Error('transient')))
      .mockResolvedValueOnce('recovered');
    const commit = vi.fn();
    const fail = vi.fn();
    const reload = createCoalescedLatestLoader({ load, commit, fail });

    await reload();
    expect(fail).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    await reload();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith('recovered');
  });

  it('starts a follow-up arriving in the drain settlement microtask window', async () => {
    const stale = deferred<string>();
    const mutation = deferred<void>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce('latest');
    const commit = vi.fn();
    const reload = createCoalescedLatestLoader({ load, commit, fail: vi.fn() });

    const first = reload();
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    const followUp = mutation.promise.then(reload);
    // Queue drain's continuation before the mutation continuation. The second
    // reload then lands after drain returns but before an external `.finally`
    // callback would have cleared the active promise.
    stale.resolve('stale');
    mutation.resolve();
    await Promise.all([first, followUp]);

    expect(load).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith('latest');
  });

  it('uses one refresh when first-page and terminal state arrive in the same replay commit', async () => {
    const reload = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        createElement(RefreshHarness, {
          sessionId: 'session-complete',
          stageId: 'stage-complete',
          pageCount: 4,
          status: 'succeeded',
          reload,
        }),
      ),
    );

    expect(reload).toHaveBeenCalledOnce();
  });
});

/**
 * The library trigger — `create_folder` / `create_stage` / `move_to_folder`.
 *
 * These are exactly the writes the page-boundary triggers CANNOT see: a fresh
 * stage has no pages and a folder is not a course, so `pageCount` never leaves
 * 0. The fold counts the durable `library_changed` events and this hook answers
 * an increase with the same authoritative refetch generated courses use.
 */
describe('library change discovery sync', () => {
  const mount = async (props: {
    sessionId: string | null;
    stageId: string | null;
    pageCount: number;
    status: SessionStatus;
    libraryRevision?: number;
    reload: () => void;
  }) => {
    if (!root) {
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => root?.render(createElement(RefreshHarness, props)));
  };

  it('refreshes on every library write, with no page and no stage of its own', async () => {
    const reload = vi.fn();
    const props = {
      sessionId: 'session-1',
      // A run that has only created a folder owns no stage and no page yet.
      stageId: null,
      pageCount: 0,
      status: 'running' as SessionStatus,
      reload,
    };
    await mount({ ...props, libraryRevision: 0 });
    expect(reload).not.toHaveBeenCalled();

    // create_folder
    await mount({ ...props, libraryRevision: 1 });
    expect(reload).toHaveBeenCalledTimes(1);
    // create_stage
    await mount({ ...props, libraryRevision: 2 });
    expect(reload).toHaveBeenCalledTimes(2);
    // move_to_folder
    await mount({ ...props, libraryRevision: 3 });
    expect(reload).toHaveBeenCalledTimes(3);

    // A re-render that changes nothing else must not refetch again.
    await mount({ ...props, libraryRevision: 3 });
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('treats the first observed count as a baseline, not as news', async () => {
    // Attaching to an old session replays its whole log in one commit, so the
    // counter arrives already at 3. The shell loaded the list on mount, so those
    // folders are already in it — refetching here would be a redundant read.
    const reload = vi.fn();
    await mount({
      sessionId: 'session-old',
      stageId: 'stage-old',
      pageCount: 0,
      status: 'succeeded',
      libraryRevision: 3,
      reload,
    });
    expect(reload).not.toHaveBeenCalled();

    // A write made while attached still refreshes.
    await mount({
      sessionId: 'session-old',
      stageId: 'stage-old',
      pageCount: 0,
      status: 'succeeded',
      libraryRevision: 4,
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rebaselines per run, so switching sessions does not refetch on the swap', async () => {
    const reload = vi.fn();
    await mount({
      sessionId: 'session-a',
      stageId: 'stage-a',
      pageCount: 0,
      status: 'running',
      libraryRevision: 5,
      reload,
    });
    expect(reload).not.toHaveBeenCalled();
    // Another session's fold starts its own count; a LOWER number arriving must
    // read as "different run", never as a write.
    await mount({
      sessionId: 'session-b',
      stageId: 'stage-b',
      pageCount: 0,
      status: 'running',
      libraryRevision: 1,
      reload,
    });
    expect(reload).not.toHaveBeenCalled();
    await mount({
      sessionId: 'session-b',
      stageId: 'stage-b',
      pageCount: 0,
      status: 'running',
      libraryRevision: 2,
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves the page-boundary refreshes exactly as they were', async () => {
    // The library counter is additive: a run that never writes to the library
    // behaves like it did before this trigger existed.
    const reload = vi.fn();
    const base = { sessionId: 'session-2', stageId: 'stage-2', libraryRevision: 0, reload };
    await mount({ ...base, pageCount: 0, status: 'running' });
    expect(reload).not.toHaveBeenCalled();
    await mount({ ...base, pageCount: 1, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    await mount({ ...base, pageCount: 2, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    await mount({ ...base, pageCount: 2, status: 'succeeded' });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('counts a library write during a build on top of the page boundaries', async () => {
    // The realistic series shape: create_folder, create_stage, switch, build a
    // page, file the course. Every one of those is a tree change the user should
    // see, and each gets exactly one refetch.
    const reload = vi.fn();
    const run = { sessionId: 'session-3', stageId: 'stage-3', reload };
    await mount({ ...run, pageCount: 0, status: 'running', libraryRevision: 0 });
    await mount({ ...run, pageCount: 0, status: 'running', libraryRevision: 2 });
    expect(reload).toHaveBeenCalledTimes(1);
    await mount({ ...run, pageCount: 1, status: 'running', libraryRevision: 2 });
    expect(reload).toHaveBeenCalledTimes(2);
    await mount({ ...run, pageCount: 1, status: 'running', libraryRevision: 3 });
    expect(reload).toHaveBeenCalledTimes(3);
    await mount({ ...run, pageCount: 1, status: 'succeeded', libraryRevision: 3 });
    expect(reload).toHaveBeenCalledTimes(4);
  });
});
