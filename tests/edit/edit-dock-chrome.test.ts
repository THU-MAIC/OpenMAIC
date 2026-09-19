import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/edit/AgentsView/RosterDialog', () => ({
  RosterDialog: () => null,
}));
vi.mock('@/components/edit/EditDock/ElementRefLassoButton', () => ({
  ElementRefLassoButton: () => createElement('button', { 'data-testid': 'element-lasso' }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { DockEditBar } from '@/components/edit/EditDock/DockEditBar';

describe('global edit control bar', () => {
  it('keeps course-level roster, pager, and available element actions in one persistent bar', () => {
    const html = renderToStaticMarkup(
      createElement(DockEditBar, {
        sceneId: 'scene-1',
        canPickElements: true,
        pager: {
          index: 1,
          count: 3,
          canPrev: true,
          canNext: true,
          onPrev: vi.fn(),
          onNext: vi.fn(),
        },
      }),
    );

    expect(html).toContain('data-testid="edit-dock-bar"');
    expect(html).toContain('data-testid="edit-dock-roster"');
    expect(html).toContain('data-testid="element-lasso"');
    expect(html).toContain('2 / 3');
  });

  it('omits the lasso when the current surface cannot perform that action', () => {
    const html = renderToStaticMarkup(
      createElement(DockEditBar, { sceneId: 'scene-1', canPickElements: false }),
    );
    expect(html).not.toContain('data-testid="element-lasso"');
  });
});
