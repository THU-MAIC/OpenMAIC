// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { CONTENT_FIT_BASE_CSS, CONTENT_FIT_SHIM } from '@/lib/interactive/content-fit-shim';

function shimBody(): string {
  const body = CONTENT_FIT_SHIM.match(
    /<script data-iframe-content-fit-shim>([\s\S]*?)<\/script>/,
  )?.[1];
  expect(body).toBeTruthy();
  return body as string;
}

function box(el: Element, left: number, top: number, width: number, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

// Installed once: like the real page, the shim keeps its window listeners.
beforeAll(() => {
  new Function(shimBody())();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('content fit injection', () => {
  it('injects the media defaults and the measuring shim ahead of the page', () => {
    const out = patchHtmlForIframe(
      '<!DOCTYPE html><html><head><style>canvas{max-width:none}</style><script>window.page=1</script></head><body></body></html>',
    );
    expect(CONTENT_FIT_BASE_CSS).toContain(':where(canvas, img, svg, video)');
    expect(CONTENT_FIT_BASE_CSS).toContain('max-width: 100%');
    expect(out).toContain(CONTENT_FIT_BASE_CSS);
    expect(out).toContain('data-iframe-content-fit-shim');
    // Both land before the authored style and script, so authored rules still win.
    expect(out.indexOf(CONTENT_FIT_BASE_CSS)).toBeLessThan(out.indexOf('canvas{max-width:none}'));
    expect(out.indexOf('data-iframe-content-fit-shim')).toBeLessThan(out.indexOf('window.page=1'));
  });

  it('reports content that spills right or is clipped, but not fully hidden panels', async () => {
    // Longhands: jsdom does not expand the \`overflow\` shorthand; browsers do.
    document.body.innerHTML = `
      <main id="main" style="overflow-x: hidden; overflow-y: hidden">
        <section id="wide"></section>
        <aside id="offscreen"></aside>
      </main>
      <div id="scroller" style="overflow-y: auto"><div id="inner"></div></div>`;
    box(document.body, 0, 0, 1024, 768);
    box(document.getElementById('main')!, 0, 0, 1024, 700);
    // Partly clipped by <main>: counts in full.
    box(document.getElementById('wide')!, 0, 0, 1400, 950);
    // Entirely outside <main>'s box: an off-canvas drawer, skipped.
    box(document.getElementById('offscreen')!, 3000, 0, 400, 700);
    box(document.getElementById('scroller')!, 0, 700, 600, 60);
    // Reachable through its own scroller: not counted.
    box(document.getElementById('inner')!, 0, 700, 600, 4000);

    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent('message', { data: { __maicFitReportRequest: true } }));
    // Answered after the throttle, once a just-resized page has laid out, and an
    // overflow only once a second measurement confirms it.
    expect(post).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(post.mock.calls.some(([m]) => (m as { kind?: string }).kind === 'content-extent')).toBe(
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const reports = post.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.kind === 'content-extent');
    expect(reports.at(-1)).toMatchObject({
      __maicInteractive: true,
      kind: 'content-extent',
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      contentWidth: 1400,
      contentHeight: 950,
    });
  });

  it('scrolls the page when the host cue asks', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const scrollBy = vi.fn();
    const scroller = document.scrollingElement ?? document.documentElement;
    (scroller as unknown as { scrollBy: typeof scrollBy }).scrollBy = scrollBy;
    window.dispatchEvent(new MessageEvent('message', { data: { __maicFitScrollBy: true } }));
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });
});
