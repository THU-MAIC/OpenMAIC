// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));

import { LibrarySkeleton } from '@/components/discovery/library-skeleton';

function render(): HTMLElement {
  const host = document.createElement('div');
  // Server-rendered: the skeleton is on screen before the page's scripts run.
  host.innerHTML = renderToString(createElement(LibrarySkeleton));
  return host;
}

describe('LibrarySkeleton', () => {
  it('server-renders a loading region of folder and course tiles', () => {
    const host = render();
    const region = host.querySelector('[data-library-skeleton]')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-label')).toBe('common.loading');
    const tiles = [...region.querySelectorAll('[data-skeleton-tile]')];
    expect(tiles.map((tile) => tile.getAttribute('data-skeleton-tile'))).toEqual([
      'folder',
      'folder',
      'course',
      'course',
      'course',
      'course',
      'course',
      'course',
    ]);
  });

  it('uses the loaded grid and the cards’ 16:9 thumbnail and title row', () => {
    const host = render();
    const grid = host.querySelector('[data-library-skeleton] > div')!;
    // The classes of the loaded course grid in app/page.tsx.
    expect(grid.className).toBe('grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8');
    for (const tile of host.querySelectorAll('[data-skeleton-tile]')) {
      const [thumbnail, row] = [...tile.children];
      expect(thumbnail!.className).toContain('aspect-[16/9] rounded-2xl');
      expect(row!.className).toBe('mt-2.5 px-1 flex items-center gap-2');
      expect(row!.querySelector('p')!.className).toContain('font-medium text-[15px]');
      expect(tile.querySelector('.animate-pulse')).not.toBeNull();
    }
  });
});
