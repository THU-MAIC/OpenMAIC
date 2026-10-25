// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PPTChartElement,
  PPTCodeElement,
  PPTLatexElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  Stage,
} from '@openmaic/dsl';

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

  const labeledShapeElement: PPTShapeElement = {
    id: 'shape-labeled-1',
    type: 'shape',
    left: 20,
    top: 240,
    width: 100,
    height: 60,
    rotate: 0,
    viewBox: [100, 60],
    path: 'M 0 0 L 100 0 L 100 60 L 0 60 Z',
    fill: '#3b82f6',
    fixedRatio: false,
    text: {
      content: '<p>Flowchart: Step 2 &amp; Review</p>',
      defaultFontName: 'Arial',
      defaultColor: '#ffffff',
      align: 'middle',
    },
  };

  const tableElement: PPTTableElement = {
    id: 'table-1',
    type: 'table',
    left: 20,
    top: 340,
    width: 300,
    height: 100,
    rotate: 0,
    colWidths: [0.5, 0.5],
    cellMinHeight: 30,
    outline: { width: 1, style: 'solid', color: '#ccc' },
    data: [
      [
        { id: 'c1', colspan: 1, rowspan: 1, text: 'Alpha &amp; Beta' },
        { id: 'c2', colspan: 1, rowspan: 1, text: 'Score &gt; 90' },
      ],
      [
        { id: 'c3', colspan: 1, rowspan: 1, text: 'Gamma' },
        { id: 'c4', colspan: 1, rowspan: 1, text: 'Pass' },
      ],
    ],
  };

  const chartElement: PPTChartElement = {
    id: 'chart-1',
    type: 'chart',
    left: 20,
    top: 450,
    width: 300,
    height: 180,
    rotate: 0,
    chartType: 'bar',
    themeColors: ['#5b9bd5'],
    data: {
      labels: ['Q1', 'Q2'],
      legends: ['Revenue', 'Profit'],
      series: [
        [100, 150],
        [20, 30],
      ],
    },
  };

  const latexElement: PPTLatexElement = {
    id: 'latex-1',
    type: 'latex',
    left: 20,
    top: 640,
    width: 250,
    height: 60,
    rotate: 0,
    latex: 'E = mc^2',
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

  it('copies table-cell text on table-only boards instead of reporting no text to copy', async () => {
    const stage: Stage = {
      id: 'st-table',
      name: 'Table Test',
      whiteboard: [
        {
          id: 'wb-table',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [tableElement],
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
    expect(clipboardWriteMock).toHaveBeenCalledWith('Alpha & Beta\nScore > 90\nGamma\nPass');
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');
    expect(toastMocks.info).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('copies mixed whiteboard containing text, table, and code in board order', async () => {
    const stage: Stage = {
      id: 'st-mixed',
      name: 'Mixed Test',
      whiteboard: [
        {
          id: 'wb-mixed',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          // Board order: text, shape (ignored), table, code
          elements: [textElement, shapeElement, tableElement, codeElement],
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
      'Step 1: Introduction\nKey formula: a & b\n\nAlpha & Beta\nScore > 90\nGamma\nPass\n\nfunction run() {\n  return 42;\n}';
    expect(clipboardWriteMock).toHaveBeenCalledWith(expected);
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');

    await act(async () => root.unmount());
  });

  it('copies labeled shape text on shape-only boards instead of reporting no text to copy', async () => {
    const stage: Stage = {
      id: 'st-shape-only',
      name: 'Shape Test',
      whiteboard: [
        {
          id: 'wb-shape-only',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [labeledShapeElement],
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
    expect(clipboardWriteMock).toHaveBeenCalledWith('Flowchart: Step 2 & Review');
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');
    expect(toastMocks.info).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('copies mixed whiteboard containing text, labeled shape, table, and code in board order', async () => {
    const stage: Stage = {
      id: 'st-mixed-all',
      name: 'Mixed All Test',
      whiteboard: [
        {
          id: 'wb-mixed-all',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          // Board order: text, labeled shape, unlabeled shape (ignored), table, code
          elements: [textElement, labeledShapeElement, shapeElement, tableElement, codeElement],
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
      'Step 1: Introduction\nKey formula: a & b\n\nFlowchart: Step 2 & Review\n\nAlpha & Beta\nScore > 90\nGamma\nPass\n\nfunction run() {\n  return 42;\n}';
    expect(clipboardWriteMock).toHaveBeenCalledWith(expected);
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');

    await act(async () => root.unmount());
  });

  it('copies chart label, legend, and visible series value text on chart-only boards instead of reporting no text to copy', async () => {
    const stage: Stage = {
      id: 'st-chart-only',
      name: 'Chart Test',
      whiteboard: [
        {
          id: 'wb-chart-only',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [chartElement],
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
    expect(clipboardWriteMock).toHaveBeenCalledWith(
      'Q1\nQ2\nRevenue\nProfit\n' + 'Revenue: Q1 100, Q2 150\n' + 'Profit: Q1 20, Q2 30',
    );
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');
    expect(toastMocks.info).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('copies formula text on formula-only boards instead of reporting no text to copy', async () => {
    const stage: Stage = {
      id: 'st-formula-only',
      name: 'Formula Test',
      whiteboard: [
        {
          id: 'wb-formula-only',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [latexElement],
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
    expect(clipboardWriteMock).toHaveBeenCalledWith('E = mc^2');
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');
    expect(toastMocks.info).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('copies mixed whiteboard containing text, chart, formula, table, shape, and code in board order', async () => {
    const stage: Stage = {
      id: 'st-mixed-full',
      name: 'Mixed Full Test',
      whiteboard: [
        {
          id: 'wb-mixed-full',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          // Board order: text, latex, chart, labeled shape, table, code
          elements: [
            textElement,
            latexElement,
            chartElement,
            labeledShapeElement,
            tableElement,
            codeElement,
          ],
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
      'Step 1: Introduction\nKey formula: a & b\n\n' +
      'E = mc^2\n\n' +
      'Q1\nQ2\nRevenue\nProfit\n' +
      'Revenue: Q1 100, Q2 150\n' +
      'Profit: Q1 20, Q2 30\n\n' +
      'Flowchart: Step 2 & Review\n\n' +
      'Alpha & Beta\nScore > 90\nGamma\nPass\n\n' +
      'function run() {\n  return 42;\n}';
    expect(clipboardWriteMock).toHaveBeenCalledWith(expected);
    expect(toastMocks.success).toHaveBeenCalledWith('Copied all text to clipboard');

    await act(async () => root.unmount());
  });
});
