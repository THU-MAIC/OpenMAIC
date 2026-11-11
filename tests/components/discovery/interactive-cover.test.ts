// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InteractiveCover } from '@/components/discovery/interactive-cover';
import type { InteractiveCoverData } from '@/lib/utils/course-cover';

function render(cover: InteractiveCoverData, compact = false): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToString(createElement(InteractiveCover, { cover, compact }));
  return host;
}

function cover(data: Partial<InteractiveCoverData>): InteractiveCoverData {
  return { title: '', widgetType: null, ...data };
}

describe('InteractiveCover', () => {
  it('shows the widget kind glyph for each kind', () => {
    const glyphs = {
      simulation: 'flask-conical',
      diagram: 'workflow',
      code: 'code-xml',
      game: 'gamepad-2',
      visualization3d: 'box',
      'procedural-skill': 'list-checks',
    } as const;
    for (const [widgetType, glyph] of Object.entries(glyphs)) {
      const host = render(cover({ widgetType: widgetType as InteractiveCoverData['widgetType'] }));
      expect(host.querySelector(`svg.lucide-${glyph}`), widgetType).not.toBeNull();
    }
  });

  it('falls back to the interactive-mode atom without a widget kind', () => {
    const host = render(cover({ title: 'Untitled page' }));
    expect(host.querySelector('svg.lucide-atom')).not.toBeNull();
  });

  it('shows the title as text (two clamped lines), never an iframe', () => {
    const host = render(cover({ title: 'Build a water cycle', widgetType: 'game' }));
    const title = host.querySelector('p')!;
    expect(title.textContent).toBe('Build a water cycle');
    expect(title.className).toContain('line-clamp-2');
    expect(host.querySelector('iframe')).toBeNull();
  });

  it('is decorative: aria-hidden, with or without a title', () => {
    expect(render(cover({ title: 'Tides' })).firstElementChild!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    const bare = render(cover({}));
    expect(bare.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(bare.querySelector('p')).toBeNull();
  });

  it('drops the title in compact mode (the small chat chip)', () => {
    const host = render(cover({ title: 'Cell division', widgetType: 'diagram' }), true);
    expect(host.querySelector('p')).toBeNull();
    expect(host.querySelector('svg.lucide-workflow')).not.toBeNull();
  });
});
