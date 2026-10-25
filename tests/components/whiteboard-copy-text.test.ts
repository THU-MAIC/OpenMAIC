// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTCodeElement, PPTTextElement, PPTShapeElement, Stage } from '@openmaic/dsl';

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: {
    div: ({ children, className, style }: React.HTMLAttributes<HTMLDivElement>) =>
      createElement('div', { className, style }, children),
    button: ({
      children,
      onClick,
      disabled,
      title,
      className,
      'data-testid': testId,
      'aria-label': ariaLabel,
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-testid'?: string }) =>
      createElement(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          title,
          className,
          'data-testid': testId,
          'aria-label': ariaLabel,
        },
        children,
      ),
  },
}));

vi.mock('lucide-react', () => ({
  Copy: () => createElement('span', { 'data-icon': 'copy' }),
  Eraser: () => createElement('span', { 'data-icon': 'eraser' }),
  History: () => createElement('span', { 'data-icon': 'history' }),
  Minimize2: () => createElement('span', { 'data-icon': 'minimize' }),
  PencilLine: () => createElement('span', { 'data-icon': 'pencil' }),
  RotateCcw: () => createElement('span', { 'data-icon': 'rotate' }),
}));

vi.mock('@/components/whiteboard/whiteboard-canvas', () => ({
  WhiteboardCanvas: () => createElement('div', { 'data-testid': 'whiteboard-canvas' }),
}));

vi.mock('@/components/whiteboard/whiteboard-history', () => ({
  WhiteboardHistory: () => null,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'whiteboard.title': 'Interactive Whiteboard',
        'whiteboard.clear': 'Clear Whiteboard',
        'whiteboard.history': 'History',
        'whiteboard.minimize': 'Minimize Whiteboard',
        'whiteboard.copyAllText': 'Copy all text',
        'whiteboard.copySuccess': 'Copied all text to clipboard',
        'whiteboard.copyError': 'Failed to copy text',
        'whiteboard.copyEmpty': 'No text to copy',
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock('@/lib/whiteboard/runtime/browser-projection', () => ({
  refreshWhiteboardRuntimeProjection: vi.fn(),
}));

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { Whiteboard } from '@/components/whiteboard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Whiteboard "Copy all text" action', () => {
  let clipboardWriteMock: ReturnType<typeof vi.fn>;
  let container: HTMLDivElement;

  const textElement: PPTTextElement = {
    id: 'text-1',
    type: 'text',
    left: 20,
    top: 20,
    width: 200,
    height: 60,
    rotate: 0,
    content: '<p>Step 1: Introduction</p><p>Key formula: a &amp; b</p>',
    defaultColor: '#000000',
    defaultFontName: 'Arial',
  };

  const codeElement: PPTCodeElement = {
    id: 'code-1',
    type: 'code',
    left: 20,
    top: 100,
    width: 400,
    height: 120,
    rotate: 0,
    language: 'javascript',
    lines: [
      { id: 'l1', content: 'function run() {' },
      { id: 'l2', content: '  return 42;' },
      { id: 'l3', content: '}' },
    ],
    showLineNumbers: true,
  };

  const shapeElement: PPTShapeElement = {
    id: 'shape-1',
    type: 'shape',
    left: 20,
    top: 240,
    width: 80,
    height: 80,
    rotate: 0,
    viewBox: [80, 80],
    path: 'M 0 0 L 80 80 Z',
    fill: '#00ff00',
    fixedRatio: false,
  };

  beforeEach(() => {
    clipboardWriteMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: clipboardWriteMock,
      },
    });

    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    toastMocks.info.mockReset();

    useCanvasStore.setState({
      whiteboardOpen: true,
      whiteboardClearing: false,
      runtimeWhiteboardProjection: null,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    useStageStore.setState({ stage: null });
    useCanvasStore.setState({
      whiteboardOpen: false,
      whiteboardClearing: false,
      runtimeWhiteboardProjection: null,
    });
  });

  it('renders "Copy all text" button beside clear and history controls', async () => {
    const stage: Stage = {
      id: 'st-1',
      name: 'Test',
      whiteboard: [
        {
          id: 'wb-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [textElement],
        },
      ],
    } as unknown as Stage;
    useStageStore.setState({ stage });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.getAttribute('title')).toBe('Copy all text');
    expect(copyBtn.getAttribute('aria-label')).toBe('Copy all text');
    expect(copyBtn.querySelector('[data-icon="copy"]')).not.toBeNull();

    // Verify clear and history buttons exist alongside copy button
    const clearBtn = container.querySelector('button[title="Clear Whiteboard"]');
    const historyBtn = container.querySelector('button[title="History"]');
    expect(clearBtn).not.toBeNull();
    expect(historyBtn).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('copies combined text and code elements in board order with line breaks and formatting', async () => {
    const stage: Stage = {
      id: 'st-1',
      name: 'Test',
      whiteboard: [
        {
          id: 'wb-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          // Interleaved: text, non-text shape, code
          elements: [textElement, shapeElement, codeElement],
        },
      ],
    } as unknown as Stage;
    useStageStore.setState({ stage });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn.click();
    });

    expect(clipboardWriteMock).toHaveBeenCalledTimes(1);
    const expected =
      'Step 1: Introduction\nKey formula: a & b\n\nfunction run() {\n  return 42;\n}';
    expect(clipboardWriteMock).toHaveBeenCalledWith(expected);
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.info).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('handles empty whiteboard content gracefully without writing to clipboard', async () => {
    const stage: Stage = {
      id: 'st-1',
      name: 'Test',
      whiteboard: [
        {
          id: 'wb-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [shapeElement], // only non-text element
        },
      ],
    } as unknown as Stage;
    useStageStore.setState({ stage });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn.click();
    });

    expect(clipboardWriteMock).not.toHaveBeenCalled();
    expect(toastMocks.info).toHaveBeenCalledWith('No text to copy');
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('handles clipboard failure gracefully when clipboard.writeText rejects', async () => {
    clipboardWriteMock.mockRejectedValue(new Error('Clipboard permission denied'));

    const stage: Stage = {
      id: 'st-1',
      name: 'Test',
      whiteboard: [
        {
          id: 'wb-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [textElement],
        },
      ],
    } as unknown as Stage;
    useStageStore.setState({ stage });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;

    await act(async () => {
      copyBtn.click();
    });

    expect(clipboardWriteMock).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to copy text');
    expect(toastMocks.success).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('disables the copy button while whiteboard is clearing', async () => {
    const stage: Stage = {
      id: 'st-1',
      name: 'Test',
      whiteboard: [
        {
          id: 'wb-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [textElement],
        },
      ],
    } as unknown as Stage;
    useStageStore.setState({ stage });
    useCanvasStore.setState({ whiteboardClearing: true });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);

    await act(async () => {
      copyBtn.click();
    });

    expect(clipboardWriteMock).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('supports copying whiteboard text under runtime store authority', async () => {
    const stage: Stage = {
      id: 'st-runtime',
      name: 'Runtime Test',
      whiteboard: [],
    } as unknown as Stage;
    useStageStore.setState({ stage });
    useCanvasStore.setState({
      runtimeWhiteboardProjection: {
        stageId: 'st-runtime',
        lastSeq: 5,
        whiteboard: {
          id: 'wb-runtime',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [codeElement],
        },
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Whiteboard, { isOpen: true, onClose: vi.fn() }));
    });

    // In runtime authority, clear and history are hidden, but copy button is visible and active
    const clearBtn = container.querySelector('button[title="Clear Whiteboard"]');
    expect(clearBtn).toBeNull();

    const copyBtn = container.querySelector(
      'button[data-testid="whiteboard-copy-all-text"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn.click();
    });

    expect(clipboardWriteMock).toHaveBeenCalledWith('function run() {\n  return 42;\n}');
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');

    await act(async () => root.unmount());
  });
});
