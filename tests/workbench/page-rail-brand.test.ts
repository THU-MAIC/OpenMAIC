// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageRail } from '@/components/stage/page-rail';
import { WorkbenchPanelProvider } from '@/lib/workbench/panel-context';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PageRail brand', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const render = async (hosted: boolean) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = { collapsed: false, onCollapseChange: () => {}, children: null };
    const rail = createElement(PageRail, props);
    await act(async () =>
      root?.render(hosted ? createElement(WorkbenchPanelProvider, null, rail) : rail),
    );
    return host;
  };

  it('keeps the logo where the page list is the only brand on screen', async () => {
    const page = await render(false);
    expect(page.querySelector('img')).not.toBeNull();
    expect(page.querySelector('[data-testid="page-rail-collapse"]')).not.toBeNull();
  });

  it('leaves only the collapse button inside the workbench', async () => {
    const page = await render(true);
    expect(page.querySelector('img')).toBeNull();
    const collapse = page.querySelector('[data-testid="page-rail-collapse"]');
    expect(collapse).not.toBeNull();
    expect(collapse?.parentElement?.children).toHaveLength(1);
  });
});
