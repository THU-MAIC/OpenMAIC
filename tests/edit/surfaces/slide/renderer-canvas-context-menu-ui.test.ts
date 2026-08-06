// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PPTTextElement } from '@openmaic/dsl';
import type { RendererCanvasCommands } from '@/components/edit/surfaces/slide/renderer-canvas-commands';
import { RendererCanvasContextMenu } from '@/components/edit/surfaces/slide/RendererCanvasContextMenu';
import type { SlideContent } from '@/lib/types/stage';

const grouped = (id: string): PPTTextElement => ({
  id,
  type: 'text',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
  content: `<p>${id}</p>`,
  defaultFontName: 'Inter',
  defaultColor: '#111111',
  groupId: 'G',
});

function commands(): RendererCanvasCommands {
  return {
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    deleteSelection: vi.fn(),
    lockSelection: vi.fn(),
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    pasteElements: vi.fn(),
    unlockTarget: vi.fn(),
    toggleGroup: vi.fn(),
    reorderTarget: vi.fn(),
    alignSelection: vi.fn(),
  };
}

describe('RendererCanvasContextMenu UI', () => {
  it('selects a right-clicked group and opens the element menu', async () => {
    const content = {
      type: 'slide',
      canvas: {
        id: 'slide',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [grouped('g1'), grouped('g2')],
      },
    } as SlideContent;
    const onSelectionChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          RendererCanvasContextMenu,
          {
            content,
            selection: { elementIds: [] },
            commands: commands(),
            onSelectionChange,
          },
          createElement('div', { 'data-testid': 'target', 'data-element-id': 'g2' }),
        ),
      );
    });

    const target = container.querySelector('[data-testid="target"]') as HTMLElement;
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });

    expect(onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['g1', 'g2'],
      primaryId: 'g2',
    });
    expect(document.querySelector('[data-command="copy"]')).not.toBeNull();
    expect(document.querySelector('[data-command="cut"]')).not.toBeNull();
    expect(document.querySelector('[data-command="paste"]')).not.toBeNull();
    expect(document.querySelector('[data-command="lock"]')).not.toBeNull();
    expect(document.querySelector('[data-command="delete"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
