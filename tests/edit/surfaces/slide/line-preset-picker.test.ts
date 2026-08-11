import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LinePresetPicker } from '@/components/edit/surfaces/slide/LinePresetPicker';

describe('LinePresetPicker', () => {
  it('renders the curved-line preset as a selectable control', () => {
    const html = renderToStaticMarkup(createElement(LinePresetPicker, { onPick: vi.fn() }));

    expect(html).toContain('aria-label="曲线"');
    expect(html).toContain('aria-label="三次曲线"');
  });
});
