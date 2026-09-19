import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SlideBackground } from '@openmaic/dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolution: { kind: 'placeholder' } as { kind: 'placeholder' } | { kind: 'url'; url: string },
}));

vi.mock('@/lib/contexts/media-stage-context', () => ({
  useMediaStageId: () => 'stage-background',
}));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: (selector: (state: { tasks: Record<string, never> }) => unknown) =>
    selector({ tasks: {} }),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: { imageGenerationEnabled: boolean }) => unknown) =>
    selector({ imageGenerationEnabled: true }),
}));

vi.mock('@/lib/media/resolve-media-ref', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/resolve-media-ref')>();
  return {
    ...actual,
    useResolvedMediaRef: () => mocks.resolution,
  };
});

import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';

const allocatedRef = 'ast_background_allocation';
const background: SlideBackground = {
  type: 'image',
  image: { src: allocatedRef, size: 'cover' },
};

describe('useSlideBackgroundStyle', () => {
  function Probe() {
    return createElement('div', { style: useSlideBackgroundStyle(background).backgroundStyle });
  }

  beforeEach(() => {
    mocks.resolution = { kind: 'placeholder' };
  });

  it('uses the resolved allocation and never the opaque ref in CSS', () => {
    mocks.resolution = { kind: 'url', url: 'blob:resolved-background' };

    const markup = renderToStaticMarkup(createElement(Probe));

    expect(markup).toContain('background-image:url(blob:resolved-background)');
    expect(markup).not.toContain(allocatedRef);
  });

  it('does not emit CSS url() while an allocation is unresolved', () => {
    const markup = renderToStaticMarkup(createElement(Probe));

    expect(markup).toContain('background-color:#fff');
    expect(markup).not.toContain('url(');
    expect(markup).not.toContain(allocatedRef);
  });
});
