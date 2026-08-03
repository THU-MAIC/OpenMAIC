import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { ActionEngine } from '@/lib/action/engine';

const mocks = vi.hoisted(() => ({
  addElement: vi.fn(),
  getWhiteboard: vi.fn(() => ({ success: true, data: { id: 'wb-1', elements: [] } })),
  renderToString: vi.fn((latex: string) =>
    latex === String.raw`\frac{1}{`
      ? '<span class="katex-error">malformed</span>'
      : '<span class="katex-display">rendered</span>',
  ),
}));

vi.mock('katex', () => ({
  default: {
    renderToString: mocks.renderToString,
  },
}));

vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({
    whiteboard: {
      get: mocks.getWhiteboard,
      addElement: mocks.addElement,
    },
  }),
}));

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({
      whiteboardOpen: true,
    }),
  },
}));

vi.mock('@/lib/store/whiteboard-history', () => ({
  useWhiteboardHistoryStore: {
    getState: () => ({ pushSnapshot: vi.fn() }),
  },
}));

vi.mock('@/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false,
  useMediaGenerationStore: {
    getState: () => ({ tasks: {}, getTask: vi.fn() }),
    subscribe: vi.fn(),
  },
}));

vi.mock('@/lib/i18n', () => ({
  getClientTranslation: () => '',
}));

const stageStore = {
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
} as unknown as StageStore;

async function drawText(content: string): Promise<void> {
  const engine = new ActionEngine(stageStore);
  const execution = engine.execute({
    id: 'text-1',
    type: 'wb_draw_text',
    content,
    x: 100,
    y: 80,
  });

  await vi.advanceTimersByTimeAsync(800);
  await execution;
}

describe('ActionEngine wb_draw_text LaTeX fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.addElement.mockClear();
    mocks.getWhiteboard.mockClear();
    mocks.renderToString.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps ordinary prose as a text element', async () => {
    await drawText('Step 1: compute the ratio');

    expect(mocks.addElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: '<p style="font-size: 18px;">Step 1: compute the ratio</p>',
      }),
      'wb-1',
    );
    expect(mocks.renderToString).not.toHaveBeenCalled();
  });

  test('renders raw LaTeX as a formatted math element', async () => {
    const latex = String.raw`\omega_{out} = \omega_{in}\cdot\frac{T_{in}}{T_{out}}`;

    await drawText(latex);

    expect(mocks.addElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'latex',
        latex,
        html: expect.stringContaining('katex-display'),
      }),
      'wb-1',
    );
    expect(mocks.renderToString).toHaveBeenCalledWith(latex, {
      throwOnError: false,
      displayMode: true,
      output: 'html',
    });
  });

  test('renders dollar-delimited math after removing the delimiters', async () => {
    await drawText('$E = mc^2$');

    expect(mocks.addElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'latex',
        latex: 'E = mc^2',
        html: expect.stringContaining('katex-display'),
      }),
      'wb-1',
    );
    expect(mocks.renderToString).toHaveBeenCalledWith('E = mc^2', {
      throwOnError: false,
      displayMode: true,
      output: 'html',
    });
  });

  test('renders expressions with a high density of less-common LaTeX commands', async () => {
    const latex = String.raw`\vec{v}+\overline{x}`;

    await drawText(latex);

    expect(mocks.addElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'latex',
        latex,
        html: expect.stringContaining('katex-display'),
      }),
      'wb-1',
    );
  });

  test.each([String.raw`\vec{v}`, String.raw`\hat{x}`, String.raw`\overline{x}`])(
    'renders a single less-common LaTeX command with a braced argument: %s',
    async (latex) => {
      await drawText(latex);

      expect(mocks.addElement).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'latex',
          latex,
          html: expect.stringContaining('katex-display'),
        }),
        'wb-1',
      );
    },
  );

  test.each([String.raw`C:\temp`, String.raw`C:\alpha`, String.raw`D:\path\to\file`])(
    'keeps a Windows path as text: %s',
    async (path) => {
      await drawText(path);

      expect(mocks.addElement).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text',
          content: expect.stringContaining(path),
        }),
        'wb-1',
      );
      expect(mocks.renderToString).not.toHaveBeenCalled();
    },
  );

  test('does not throw when fallback LaTeX is malformed', async () => {
    await expect(drawText(String.raw`\frac{1}{`)).resolves.toBeUndefined();

    expect(mocks.addElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'latex',
        html: expect.stringContaining('katex-error'),
      }),
      'wb-1',
    );
    expect(mocks.renderToString).toHaveBeenCalledWith(String.raw`\frac{1}{`, {
      throwOnError: false,
      displayMode: true,
      output: 'html',
    });
  });
});
