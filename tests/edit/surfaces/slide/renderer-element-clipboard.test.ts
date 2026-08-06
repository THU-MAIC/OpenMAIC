// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTTextElement } from '@openmaic/dsl';
import { createRendererElementClipboard } from '@/components/edit/surfaces/slide/renderer-element-clipboard';

const element: PPTTextElement = {
  id: 'text-1',
  type: 'text',
  left: 10,
  top: 20,
  width: 100,
  height: 40,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Inter',
  defaultColor: '#111111',
};

afterEach(() => vi.unstubAllGlobals());

describe('renderer element clipboard', () => {
  it('writes a versioned payload to the browser clipboard and restores an isolated clone', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    let copiedText = '';
    writeText.mockImplementation(async (value: string) => {
      copiedText = value;
    });
    vi.stubGlobal('navigator', { clipboard: { writeText, readText: vi.fn(() => copiedText) } });
    const clipboard = createRendererElementClipboard();

    await clipboard.write([element]);
    const restored = await clipboard.read();

    expect(writeText).toHaveBeenCalledOnce();
    expect(restored).toEqual([element]);
    expect(restored?.[0]).not.toBe(element);
  });

  it('uses its session fallback when browser clipboard permissions are denied', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
        readText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const clipboard = createRendererElementClipboard();

    await clipboard.write([element]);
    expect(await clipboard.read()).toEqual([element]);
  });
});
