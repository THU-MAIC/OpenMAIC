import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TextContentChange,
  TextEditorController,
  TextFormatState,
} from '@openmaic/renderer/editing';
import type { SlideContent } from '@/lib/types/stage';
import { runActiveTextCommand } from '@/lib/prosemirror/active-editor-registry';
import {
  commitRendererTextChange,
  commitRendererTextAutoSize,
  connectRendererTextController,
  mapRendererTextFormatState,
  mapToolbarCommand,
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

  it('routes toolbar commands to the active renderer controller and unregisters it', () => {
    const execute = vi.fn();
    const controller: TextEditorController = {
      elementId: 'text-1',
      execute,
      focus: vi.fn(),
      flush: vi.fn(),
      getHTML: () => '',
    };
    const detach = connectRendererTextController(controller);

    runActiveTextCommand('text-1', { command: 'align-center' });
    expect(execute).toHaveBeenCalledWith({ command: 'align', value: 'center' });

    detach();
    runActiveTextCommand('text-1', { command: 'bold' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('maps the complete existing toolbar command vocabulary', () => {
    expect(mapToolbarCommand({ command: 'bold' })).toEqual({ command: 'bold' });
    expect(mapToolbarCommand({ command: 'fontname', value: 'Inter' })).toEqual({
      command: 'fontname',
      value: 'Inter',
    });
    expect(mapToolbarCommand({ command: 'bulletList', value: 'disc' })).toEqual({
      command: 'bulletList',
      value: 'disc',
    });
  });

  it('maps every renderer format field to the existing TextAttrs contract', () => {
    const state: TextFormatState = {
      bold: true,
      em: false,
      underline: true,
      strikethrough: false,
      superscript: false,
      subscript: true,
      code: false,
      color: '#123456',
      backcolor: '#ffffff',
      fontsize: '28px',
      fontname: 'Inter',
      link: 'https://maic.chat',
      align: 'center',
      bulletList: true,
      orderedList: false,
      blockquote: false,
    };

    expect(mapRendererTextFormatState(state)).toEqual(state);
  });

  it.each([
    ['record', true],
    ['neutral', false],
  ] as const)('commits %s content with the matching host history mode', (history, isUserEdit) => {
    const commitContent = vi.spyOn(useSlideEditSession.getState(), 'commitContent');
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

    expect(commitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: [expect.objectContaining({ content: '<p>After</p>' })],
        }),
      }),
      isUserEdit,
    );
  });

  it('commits text auto-size as history-neutral normalization', () => {
    const commitContent = vi.spyOn(useSlideEditSession.getState(), 'commitContent');

    commitRendererTextAutoSize(content, {
      type: 'element.update',
      id: 'text-1',
      props: { height: 88 },
    });

    expect(commitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: [expect.objectContaining({ height: 88 })],
        }),
      }),
      false,
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
    const commitContent = vi.spyOn(useSlideEditSession.getState(), 'commitContent');

    commitRendererTextAutoSize(content, {
      type: 'element.update',
      id: 'text-1',
      props: { height: 96 },
    });

    expect(commitContent.mock.calls[0][0].canvas.elements[0]).toMatchObject({
      content: '<p>Latest input</p>',
      height: 96,
    });
  });
});
