import { describe, expect, it } from 'vitest';
import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';

describe('interactive post-processing', () => {
  it('exposes the shared pronunciation scorer to generated widgets', () => {
    const html = postProcessInteractiveHtml('<!doctype html><html><body><main>Practice</main></body></html>');
    expect(html).toContain('window.OpenMAICPronunciation');
    expect(html).toContain('matchedWords');
    expect(html.match(/OpenMAICPronunciation/g)?.length).toBe(2);
  });

  it('does not inject the scorer twice', () => {
    const source = '<html><body><script>window.OpenMAICPronunciation = {};</script></body></html>';
    expect(postProcessInteractiveHtml(source).match(/OpenMAICPronunciation/g)?.length).toBe(1);
  });
});
