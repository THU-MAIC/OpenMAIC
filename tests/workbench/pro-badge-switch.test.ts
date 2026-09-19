import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', () => ({
  motion: {
    button: ({
      whileTap: _whileTap,
      ...props
    }: ComponentProps<'button'> & { whileTap?: unknown }) => createElement('button', props),
  },
  useReducedMotion: () => true,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

import { ProBadge } from '@/components/workbench/ProBadge';

describe('Pro mode switch semantics', () => {
  it('reports classic mode as an unchecked switch', () => {
    const markup = renderToStaticMarkup(
      createElement(ProBadge, { active: false, onToggle: () => undefined }),
    );

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('data-testid="pro-mode-enter"');
  });

  it('reports both workspace exits as checked versions of the same switch', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(ProBadge, { active: true, onToggle: () => undefined }),
        createElement(ProBadge, {
          active: true,
          onToggle: () => undefined,
          testId: 'pro-workspace-hero-badge',
        }),
      ),
    );

    expect(markup.match(/role="switch"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="pro-mode-exit"');
    expect(markup).toContain('data-testid="pro-workspace-hero-badge"');
  });
});
