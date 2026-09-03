import { describe, expect, it } from 'vitest';
import type { PreviewScene } from '../src/preview-renderer.js';
import {
  countUnresolvedSlideAssetReferences,
  findExternalInteractiveDependencies,
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
  it('counts allocated slide asset refs while accepting concrete media addresses', () => {
    const scene = slideScene({
      background: { type: 'image', image: { src: 'asset_background', size: 'cover' } },
      elements: [
        { id: 'image', type: 'image', src: 'data:image/png;base64,AA==' },
        { id: 'audio', type: 'audio', src: 'asset_audio' },
        {
          id: 'video',
          type: 'video',
          src: 'https://media.example.test/video.mp4',
          mediaRef: 'asset_video',
          poster: './poster.png',
        },
      ],
    });

    expect(countUnresolvedSlideAssetReferences(scene)).toBe(3);
    expect(previewabilityError(scene)).toContain('3 unresolved asset reference(s)');
  });

  it('allows a non-empty slide whose media references are already concrete', () => {
    const scene = slideScene({
      background: { type: 'image', image: { src: '/background.png', size: 'cover' } },
      elements: [
        { id: 'image', type: 'image', src: 'images/photo.png' },
        { id: 'video', type: 'video', src: 'blob:video', poster: 'poster.png' },
      ],
    });

    expect(previewabilityError(scene)).toBeUndefined();
  });

  it('parses interactive markup and reports only hard external resource URLs', () => {
    const html = `<!doctype html><html><head>
      <script src="https://cdn.example.test/app.js"></script>
      <link href="HTTP://cdn.example.test/app.css" rel="stylesheet">
      <script>window.example = 'https://inline.example.test/not-a-resource'</script>
    </head><body>
      <img src="https://cdn.example.test/image.png">
      <audio src="https://cdn.example.test/audio.mp3"></audio>
      <video src="https://cdn.example.test/video.mp4"></video>
      <video><source src="https://cdn.example.test/alternate.mp4"></video>
      <img src="data:image/png;base64,AA=="><script src="./local.js"></script>
    </body></html>`;

    expect(findExternalInteractiveDependencies(html)).toHaveLength(6);
    expect(previewabilityError(interactiveScene(html))).toContain(
      '6 external HTTP(S) dependency reference(s)',
    );
  });

  it('accepts self-contained interactive HTML and rejects missing or blank HTML', () => {
    expect(
      previewabilityError(
        interactiveScene(
          '<!doctype html><link href="./app.css"><img src="data:image/png;base64,AA=="><script>document.body.textContent = "ok"</script>',
        ),
      ),
    ).toBeUndefined();
    expect(previewabilityError(interactiveScene())).toContain('non-empty embedded HTML');
    expect(previewabilityError(interactiveScene('   '))).toContain('non-empty embedded HTML');
  });
});
