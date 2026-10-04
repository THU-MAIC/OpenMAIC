// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';

const mocks = vi.hoisted(() => ({
  loadCourseThumbnail: vi.fn(),
  revokeThumbnailSlideMediaUrls: vi.fn(),
}));

vi.mock('@/lib/utils/course-thumbnail-cache', () => ({
  loadCourseThumbnail: mocks.loadCourseThumbnail,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  revokeThumbnailSlideMediaUrls: mocks.revokeThumbnailSlideMediaUrls,
}));

import {
  COURSE_THUMBNAIL_CONCURRENCY,
  useCourseThumbnails,
  type CourseThumbnails,
} from '@/lib/hooks/use-course-thumbnails';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Pending {
  readonly stageId: string;
  readonly signal: AbortSignal;
  resolve(value: Slide | null): void;
}

let pending: Pending[] = [];
let latest: CourseThumbnails | undefined;

function Probe({
  stageIds,
  onValue,
}: {
  readonly stageIds: readonly string[];
  readonly onValue: (value: CourseThumbnails) => void;
}) {
  const thumbnails = useCourseThumbnails();
  useEffect(() => onValue(thumbnails));
  const { requestThumbnail } = thumbnails;
  useEffect(() => {
    const withdraws = stageIds.map((id) => requestThumbnail(id, 1));
    return () => withdraws.forEach((withdraw) => withdraw());
  }, [stageIds, requestThumbnail]);
  return null;
}

function mount(stageIds: readonly string[]): Root {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(Probe, {
        stageIds,
        onValue: (value) => {
          latest = value;
        },
      }),
    ),
  );
  return root;
}

beforeEach(() => {
  pending = [];
  latest = undefined;
  mocks.loadCourseThumbnail
    .mockReset()
    .mockImplementation(
      (stageId: string, _version: number, signal: AbortSignal) =>
        new Promise<Slide | null>((resolve) => pending.push({ stageId, signal, resolve })),
    );
  mocks.revokeThumbnailSlideMediaUrls.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('useCourseThumbnails', () => {
  it('loads requested thumbnails with bounded concurrency and exposes them', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `stage-${i}`);
    const root = mount(ids);

    expect(mocks.loadCourseThumbnail).toHaveBeenCalledTimes(COURSE_THUMBNAIL_CONCURRENCY);
    expect(latest?.thumbnails).toEqual({});

    const first = { id: 'slide-0', elements: [] } as unknown as Slide;
    await act(async () => pending.shift()!.resolve(first));

    expect(latest?.thumbnails).toEqual({ 'stage-0': first });
    expect(mocks.loadCourseThumbnail).toHaveBeenCalledTimes(COURSE_THUMBNAIL_CONCURRENCY + 1);
    act(() => root.unmount());
  });

  it('aborts loads in flight and revokes loaded thumbnails when the page unmounts', async () => {
    vi.useFakeTimers();
    const root = mount(['stage-a', 'stage-b']);
    const loaded = { id: 'slide-a', elements: [] } as unknown as Slide;
    await act(async () => pending.shift()!.resolve(loaded));
    const inFlight = pending[0]!;

    act(() => root.unmount());

    expect(inFlight.signal.aborted).toBe(true);
    vi.runAllTimers();
    expect(mocks.revokeThumbnailSlideMediaUrls).toHaveBeenCalledWith(loaded);
  });
});
