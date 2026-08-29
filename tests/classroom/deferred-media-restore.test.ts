import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRestoredMediaTasks,
  buildRestoredMediaTasks,
  collectPriorityMediaRefs,
  hydrateDeferredMediaTasks,
} from '@/lib/classroom/load-classroom';
import { resolveMediaRef } from '@/lib/media/resolve-media-ref';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';

const stageId = 'stage-media';

function mediaRecord(ref: string, extra: Partial<MediaFileRecord> = {}): MediaFileRecord {
  const blob = new Blob(['media-bytes'], { type: 'image/png' });
  return {
    id: `${stageId}:${ref}`,
    stageId,
    type: 'image',
    blob,
    mimeType: 'image/png',
    size: blob.size,
    prompt: 'a generated image',
    params: '{}',
    createdAt: 1,
    ...extra,
  };
}

function slideScene(id: string, imageRef: string): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: id,
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [
          {
            id: `el-${id}`,
            type: 'image',
            src: imageRef,
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            rotate: 0,
            fixedRatio: true,
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  useMediaGenerationStore.setState({ tasks: {} });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (obj: Blob | MediaSource) =>
      `blob:mock-${(obj as Blob).size}-${Math.random().toString(36).slice(2)}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  useMediaGenerationStore.setState({ tasks: {} });
});

describe('buildRestoredMediaTasks blob deferral', () => {
  it('hydrates every blob by default (legacy callers unchanged)', () => {
    const tasks = buildRestoredMediaTasks(stageId, [mediaRecord('gen_img_1')]);
    expect(tasks['gen_img_1']?.status).toBe('done');
    expect(tasks['gen_img_1']?.objectUrl).toMatch(/^blob:/);
  });

  it('keeps deferred records done but without an objectUrl, resolving as pending', () => {
    const tasks = buildRestoredMediaTasks(stageId, [mediaRecord('gen_img_1')], [], () => false);
    const task = tasks['gen_img_1'];
    expect(task?.status).toBe('done');
    expect(task?.objectUrl).toBeUndefined();
    // The media resolution state machine must degrade gracefully: a known task
    // without bytes renders as pending (skeleton), never as a broken image.
    expect(resolveMediaRef('gen_img_1', task).kind).toBe('pending');
  });

  it('never defers failed records', () => {
    const failed = mediaRecord('gen_img_1', {
      error: 'CONTENT_SENSITIVE',
      errorCode: 'CONTENT_SENSITIVE',
    });
    const tasks = buildRestoredMediaTasks(stageId, [failed], [], () => false);
    expect(tasks['gen_img_1']?.status).toBe('failed');
  });
});

describe('collectPriorityMediaRefs', () => {
  it('collects the media refs and element ids of the current scene', () => {
    const scenes = [slideScene('scene-1', 'gen_img_1'), slideScene('scene-2', 'gen_img_2')];
    // Element ids are included because task lookup also binds records keyed by
    // element id (see resolveMediaTaskForElement).
    expect([...collectPriorityMediaRefs(scenes, 'scene-2')]).toEqual(['gen_img_2', 'el-scene-2']);
  });

  it('falls back to the first scene when no cursor is set', () => {
    const scenes = [slideScene('scene-1', 'gen_img_1'), slideScene('scene-2', 'gen_img_2')];
    expect([...collectPriorityMediaRefs(scenes, null)]).toEqual(['gen_img_1', 'el-scene-1']);
  });

  it('ignores concrete addresses (only generated refs need blob hydration)', () => {
    const scenes = [slideScene('scene-1', 'https://cdn.example.com/a.png')];
    const refs = collectPriorityMediaRefs(scenes, null);
    expect(refs.has('https://cdn.example.com/a.png')).toBe(false);
  });
});

describe('hydrateDeferredMediaTasks', () => {
  it('fills the objectUrl of a restored task in place', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);

    const task = useMediaGenerationStore.getState().tasks['gen_img_1'];
    expect(task?.objectUrl).toMatch(/^blob:/);
    expect(resolveMediaRef('gen_img_1', task).kind).toBe('url');
  });

  it('hydrates the poster together with the blob', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_vid_1: {
          elementId: 'gen_vid_1',
          type: 'video',
          status: 'done',
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });
    const record = mediaRecord('gen_vid_1', {
      type: 'video',
      mimeType: 'video/mp4',
      poster: new Blob(['poster'], { type: 'image/png' }),
    });

    await hydrateDeferredMediaTasks(stageId, [record]);

    const task = useMediaGenerationStore.getState().tasks['gen_vid_1'];
    expect(task?.objectUrl).toMatch(/^blob:/);
    expect(task?.poster).toMatch(/^blob:/);
  });

  it('skips and revokes URLs when the task was replaced by another stage', async () => {
    useMediaGenerationStore.setState({ tasks: {} });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);

    expect(useMediaGenerationStore.getState().tasks['gen_img_1']).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('does not overwrite a task that already has an objectUrl (regeneration won)', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: 'p',
          params: {},
          objectUrl: 'blob:fresh',
          retryCount: 1,
          stageId,
        },
      },
    });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);

    const task = useMediaGenerationStore.getState().tasks['gen_img_1'];
    expect(task?.objectUrl).toBe('blob:fresh');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('never writes into another stage task with the same elementId', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId: 'stage-other',
        },
      },
    });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);

    const task = useMediaGenerationStore.getState().tasks['gen_img_1'];
    expect(task?.stageId).toBe('stage-other');
    expect(task?.objectUrl).toBeUndefined();
  });

  it('does not attach stale bytes to a task that regeneration restarted', async () => {
    // A restarted task passes through pending/generating before it can be done
    // again, so it still carries no objectUrl when the idle hydration fires.
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'pending',
          prompt: 'p',
          params: {},
          retryCount: 1,
          stageId,
        },
      },
    });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);

    const task = useMediaGenerationStore.getState().tasks['gen_img_1'];
    expect(task?.status).toBe('pending');
    expect(task?.objectUrl).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('bounds idle scheduling with a timeout so a busy main thread cannot starve hydration', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });
    const ric = vi.fn((cb: IdleRequestCallback) => {
      cb({ didTimeout: true, timeRemaining: () => 0 });
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', ric);
    try {
      await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: expect.any(Number) });
    expect(useMediaGenerationStore.getState().tasks['gen_img_1']?.objectUrl).toMatch(/^blob:/);
  });

  it('stops before minting any URL when the restore was superseded', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });

    await hydrateDeferredMediaTasks(stageId, [mediaRecord('gen_img_1')], () => false);

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks['gen_img_1']?.objectUrl).toBeUndefined();
  });

  it('stops mid-loop once superseded, leaving later chunks untouched', async () => {
    const refs = ['gen_img_1', 'gen_img_2', 'gen_img_3', 'gen_img_4', 'gen_img_5'];
    useMediaGenerationStore.setState({
      tasks: Object.fromEntries(
        refs.map((ref) => [
          ref,
          {
            elementId: ref,
            type: 'image' as const,
            status: 'done' as const,
            prompt: 'p',
            params: {},
            retryCount: 0,
            stageId,
          },
        ]),
      ),
    });
    // Live for the first chunk (4 records), superseded before the second.
    let checks = 0;

    await hydrateDeferredMediaTasks(
      stageId,
      refs.map((ref) => mediaRecord(ref)),
      () => ++checks <= 1,
    );

    const tasks = useMediaGenerationStore.getState().tasks;
    for (const ref of refs.slice(0, 4)) {
      expect(tasks[ref]?.objectUrl).toMatch(/^blob:/);
    }
    expect(tasks['gen_img_5']?.objectUrl).toBeUndefined();
  });
});

describe('applyRestoredMediaTasks hydration liveness', () => {
  function restoredWithDeferred(ref: string) {
    return {
      stageId,
      tasks: {
        [ref]: {
          elementId: ref,
          type: 'image' as const,
          status: 'done' as const,
          prompt: 'p',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
      deferred: [mediaRecord(ref)],
    };
  }

  const settleHydration = () =>
    new Promise((resolve) => setTimeout(resolve, 0)).then(
      () => new Promise((r) => setTimeout(r, 0)),
    );

  it('a newer restore supersedes an in-flight hydration', async () => {
    applyRestoredMediaTasks(restoredWithDeferred('gen_img_1'), () => true);
    // Even a restore with nothing to defer retires the earlier loop.
    applyRestoredMediaTasks({ stageId, tasks: {}, deferred: [] }, () => true);

    await settleHydration();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks['gen_img_1']?.objectUrl).toBeUndefined();
  });

  it('stops hydrating once the owning classroom load is no longer current', async () => {
    applyRestoredMediaTasks(restoredWithDeferred('gen_img_1'), () => false);

    await settleHydration();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks['gen_img_1']?.objectUrl).toBeUndefined();
  });
});
