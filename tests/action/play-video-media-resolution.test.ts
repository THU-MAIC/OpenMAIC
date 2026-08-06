import { afterEach, describe, expect, it } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';
import type { StageStore } from '@/lib/api/stage-api';
import { ActionEngine } from '@/lib/action/engine';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

const stageId = 'stage-action-video';
const sharedRef = 'ast_shared_video';

function mediaTask(elementId: string, status: MediaTask['status'], objectUrl?: string): MediaTask {
  return {
    elementId,
    type: 'video',
    status,
    prompt: '',
    params: {},
    objectUrl,
    retryCount: 0,
    stageId,
  };
}

function videoElement(): PPTVideoElement {
  return {
    id: 'video-1',
    type: 'video',
    src: sharedRef,
    mediaRef: sharedRef,
    left: 0,
    top: 0,
    width: 100,
    height: 56,
    rotate: 0,
    autoplay: false,
  };
}

function actionStageStore(element: PPTVideoElement): StageStore {
  const canvas = {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#fff' },
    elements: [element],
  } as Slide;
  return {
    getState: () => ({
      stage: { id: stageId },
      scenes: [
        {
          id: 'scene-1',
          type: 'slide',
          order: 0,
          title: 'Slide',
          content: { type: 'slide', canvas },
          actions: [],
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'playback',
    }),
    setState: () => undefined,
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

describe('ActionEngine play_video media resolution', () => {
  afterEach(() => {
    useCanvasStore.getState().pauseVideo();
    useMediaGenerationStore.setState({ tasks: {} });
  });

  it('observes the element-keyed fork during targeted retry and waits until it is renderable', async () => {
    const element = videoElement();
    const source = mediaTask(sharedRef, 'done', 'blob:stale-source');
    const fork = {
      ...mediaTask(element.id, 'pending'),
      placeholderRef: sharedRef,
    };
    useMediaGenerationStore.setState({
      tasks: { [sharedRef]: source, [element.id]: fork },
    });
    const engine = new ActionEngine(actionStageStore(element));

    const execution = engine.execute({
      id: 'play-1',
      type: 'play_video',
      elementId: element.id,
    });
    await Promise.resolve();

    expect(useCanvasStore.getState().playingVideoElementId).not.toBe(element.id);

    useMediaGenerationStore.setState((state) => ({
      tasks: {
        ...state.tasks,
        [element.id]: { ...fork, status: 'done', objectUrl: 'blob:targeted-fork' },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useCanvasStore.getState().playingVideoElementId).toBe(element.id);
    useCanvasStore.getState().pauseVideo();
    await execution;
    engine.dispose();
  });
});
