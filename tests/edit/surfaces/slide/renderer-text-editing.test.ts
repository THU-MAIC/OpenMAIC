import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEditorTransaction, type EditorTransaction } from '@openmaic/editor/core';
import type { TextContentChange } from '@openmaic/editor/react';
import type { SlideContent } from '@/lib/types/stage';
import {
  commitRendererTextChange,
  commitRendererTextAutoSize,
} from '@/components/edit/surfaces/slide/renderer-text-editing';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

const content: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [
      {
        id: 'text-1',
        type: 'text',
        left: 0,
        top: 0,
        width: 200,
        height: 60,
        rotate: 0,
        content: '<p>Before</p>',
        defaultFontName: 'Arial',
        defaultColor: '#111111',
      },
    ],
  },
};

describe('renderer text editing adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSlideEditSession.setState({ sceneId: null, history: null, gestureActive: false });
  });

  it.each([['record'], ['neutral']] as const)('commits %s content as a transaction', (history) => {
    const applyTransaction = vi.spyOn(useSlideEditSession.getState(), 'applyTransaction');
    const change: TextContentChange = {
      intent: {
        type: 'text.updateContent',
        id: 'text-1',
        target: 'text',
        content: '<p>After</p>',
      },
      history,
    };

    commitRendererTextChange(content, change);

    expect(applyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'canvas',
        history,
        operations: [
          expect.objectContaining({ type: 'text.updateContent', content: '<p>After</p>' }),
        ],
      }),
    );
  });

  it('commits text auto-size as history-neutral normalization', () => {
    const applyTransaction = vi.spyOn(useSlideEditSession.getState(), 'applyTransaction');

    commitRendererTextAutoSize(content, {
      type: 'element.update',
      id: 'text-1',
      props: { height: 88 },
    });

    expect(applyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'system',
        history: 'neutral',
        operations: [expect.objectContaining({ type: 'element.update', patch: { height: 88 } })],
      }),
    );
  });

  it('applies normalization to the latest session content instead of a stale render', () => {
    const latest: SlideContent = {
      ...content,
      canvas: {
        ...content.canvas,
        elements: content.canvas.elements.map((element) =>
          element.type === 'text' ? { ...element, content: '<p>Latest input</p>' } : element,
        ),
      },
    };
    useSlideEditSession.setState({
      history: { past: [], present: latest, future: [] },
    });
    const applyTransaction = vi.spyOn(useSlideEditSession.getState(), 'applyTransaction');

    commitRendererTextAutoSize(content, {
      type: 'element.update',
      id: 'text-1',
      props: { height: 96 },
    });

    const transaction = applyTransaction.mock.calls[0][0] as EditorTransaction;
    expect(applyEditorTransaction(latest, transaction).canvas.elements[0]).toMatchObject({
      content: '<p>Latest input</p>',
      height: 96,
    });
  });
});
