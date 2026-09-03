import { describe, expect, it } from 'vitest';
import type { PreviewScene } from '../src/preview-renderer.js';
import {
  MAX_INTERACTIVE_HTML_DEPTH,
  MAX_INTERACTIVE_HTML_ELEMENTS,
  countNonSelfContainedSlideMediaReferences,
  findNonSelfContainedInteractiveReferences,
  previewabilityError,
} from '../src/preview-validation.js';

function slideScene(canvas: Record<string, unknown>): Extract<PreviewScene, { type: 'slide' }> {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    order: 1,
    title: 'Preview',
    type: 'slide',
    content: { type: 'slide', canvas },
    actions: [],
  } as unknown as Extract<PreviewScene, { type: 'slide' }>;
}

function interactiveScene(html?: string): Extract<PreviewScene, { type: 'interactive' }> {
  return {
    id: 'interactive-1',
    stageId: 'stage-1',
    order: 1,
    title: 'Widget',
    type: 'interactive',
    content: { type: 'interactive', ...(html === undefined ? { url: '/widget' } : { html }) },
    actions: [],
  };
}

describe('preview payload semantic validation', () => {
  it('accepts a background-only slide canvas', () => {
    expect(
      previewabilityError(
        slideScene({
          background: { type: 'solid', color: '#ffffff' },
          elements: [],
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects a slide canvas with neither elements nor a background', () => {
    expect(previewabilityError(slideScene({ elements: [] }))).toBe(
      'Slide canvas has no renderable elements',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object without type', {}],
  ])('rejects %s slide canvas elements without throwing', (_name, element) => {
    const scene = slideScene({ elements: [element] });

    expect(() => previewabilityError(scene)).not.toThrow();
    expect(previewabilityError(scene)).toContain('/content/canvas/elements/0');
    expect(() => countNonSelfContainedSlideMediaReferences(scene)).not.toThrow();
  });

  it('rejects every non-data slide media class across the exact DSL slots', () => {
    const scene = slideScene({
      background: { type: 'image', image: { src: 'https://example.test/background.png' } },
      elements: [
        { id: 'image', type: 'image', src: 'blob:image' },
        { id: 'audio', type: 'audio', src: './audio.mp3' },
        { id: 'video', type: 'video', mediaRef: 'asset_video', poster: '/poster.png' },
      ],
    });

    expect(countNonSelfContainedSlideMediaReferences(scene)).toBe(5);
    expect(previewabilityError(scene)).toBe(
      'Scene is not self-contained: 5 slide media reference(s) must use data: URLs',
    );
  });

  it('accepts data URLs everywhere and ignores a stale video mediaRef shadowed by data src', () => {
    const scene = slideScene({
      background: { type: 'image', image: { src: 'data:image/png;base64,AA==' } },
      elements: [
        { id: 'image', type: 'image', src: 'data:image/png;base64,AA==' },
        { id: 'audio', type: 'audio', src: 'data:audio/mpeg;base64,AA==' },
        {
          id: 'video',
          type: 'video',
          src: 'data:video/mp4;base64,AA==',
          mediaRef: 'asset_stale_video',
          poster: 'data:image/png;base64,AA==',
        },
      ],
    });

    expect(countNonSelfContainedSlideMediaReferences(scene)).toBe(0);
    expect(previewabilityError(scene)).toBeUndefined();
  });

  it.each([
    ['HTTP script src', '<script src="https://cdn.example.test/app.js"></script>'],
    ['blob image src', '<img src="blob:image">'],
    ['relative audio src', '<audio src="./sound.mp3"></audio>'],
    ['opaque asset ref', '<video src="asset_video"></video>'],
    ['external stylesheet', '<link rel="stylesheet" href="https://cdn.example.test/app.css">'],
    ['non-data srcset candidate', '<img srcset="data:image/png;base64,AA== 1x, /image@2x.png 2x">'],
    ['CSS url in a style attribute', '<div style="background:url(/background.png)"></div>'],
    [
      'HTTPS CSS url in a style attribute',
      '<div style="background:url(https://cdn.example.test/background.png)"></div>',
    ],
    [
      'CSS url in a style element',
      '<style>@font-face { src: url(https://cdn.example.test/font.woff2) }</style>',
    ],
    ['iframe src', '<iframe src="/embedded.html"></iframe>'],
  ])('rejects %s', (_name, resource) => {
    const html = `<!doctype html><html><head></head><body>${resource}</body></html>`;

    expect(findNonSelfContainedInteractiveReferences(html)).toHaveLength(1);
    expect(previewabilityError(interactiveScene(html))).toBe(
      'Interactive HTML is not self-contained: 1 resource reference(s) must be inline or use data: URLs',
    );
  });

  it('accepts data resources, an external canonical link, and an iframe without src', () => {
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://example.test/canonical">
      <link rel="stylesheet" href="data:text/css,body%7Bcolor%3Ablack%7D">
      <link rel="apple-touch-icon" href="data:image/png;base64,AA==">
      <style>@font-face { src: url(data:font/woff2;base64,AA==) }</style>
      <script src="data:text/javascript,window.ready=true"></script>
      <script>window.inline = true</script>
    </head><body style="background:url('data:image/png;base64,AA==')">
      <img src="data:image/png;base64,AA==" srcset="data:image/png;base64,AA== 1x, data:image/png;base64,AA== 2x">
      <video src="data:video/mp4;base64,AA==" poster="data:image/png;base64,AA==">
        <source src="data:video/mp4;base64,AA==">
      </video>
      <audio src="data:audio/mpeg;base64,AA=="></audio>
      <iframe></iframe><iframe src="data:text/html,ready"></iframe>
      <embed src="data:text/html,ready"><object href="data:text/plain,ready"></object>
    </body></html>`;

    expect(findNonSelfContainedInteractiveReferences(html)).toEqual([]);
    expect(previewabilityError(interactiveScene(html))).toBeUndefined();
  });

  it('accepts fragment-only CSS URLs that reference inline SVG definitions', () => {
    const html = `<!doctype html><html><head>
      <style>.clipped { clip-path: url('#clip') }</style>
    </head><body>
      <svg aria-hidden="true">
        <defs>
          <filter id="shadow"><feDropShadow dx="1" dy="1" stdDeviation="1"></feDropShadow></filter>
          <clipPath id="clip"><circle cx="50" cy="50" r="40"></circle></clipPath>
        </defs>
      </svg>
      <div class="clipped" style="filter: url(#shadow)"></div>
    </body></html>`;

    expect(findNonSelfContainedInteractiveReferences(html)).toEqual([]);
    expect(previewabilityError(interactiveScene(html))).toBeUndefined();
  });

  it('accepts an inline-only interactive page and rejects missing or blank HTML', () => {
    expect(
      previewabilityError(
        interactiveScene(
          '<!doctype html><style>body { color: green }</style><p>Ready</p><script>document.body.dataset.ready = "true"</script>',
        ),
      ),
    ).toBeUndefined();
    expect(previewabilityError(interactiveScene())).toContain('non-empty embedded HTML');
    expect(previewabilityError(interactiveScene('   '))).toContain('non-empty embedded HTML');
  });

  it('rejects interactive HTML beyond the DOM depth ceiling', () => {
    const nestingDepth = MAX_INTERACTIVE_HTML_DEPTH + 1;
    expect(nestingDepth).toBeGreaterThan(MAX_INTERACTIVE_HTML_DEPTH);
    const html = `${'<i>'.repeat(nestingDepth)}content${'</i>'.repeat(nestingDepth)}`;

    expect(() => findNonSelfContainedInteractiveReferences(html)).toThrow(
      `maximum DOM depth of ${MAX_INTERACTIVE_HTML_DEPTH}`,
    );
    expect(previewabilityError(interactiveScene(html))).toContain(
      `maximum DOM depth of ${MAX_INTERACTIVE_HTML_DEPTH}`,
    );
  });

  it('rejects interactive HTML beyond the element-count ceiling', () => {
    const elementCount = MAX_INTERACTIVE_HTML_ELEMENTS + 1;
    expect(elementCount).toBeGreaterThan(MAX_INTERACTIVE_HTML_ELEMENTS);
    const html = '<!doctype html><body>' + '<i></i>'.repeat(elementCount) + '</body>';

    expect(() => findNonSelfContainedInteractiveReferences(html)).toThrow(
      `maximum element count of ${MAX_INTERACTIVE_HTML_ELEMENTS}`,
    );
    expect(previewabilityError(interactiveScene(html))).toContain(
      `maximum element count of ${MAX_INTERACTIVE_HTML_ELEMENTS}`,
    );
  });
});
