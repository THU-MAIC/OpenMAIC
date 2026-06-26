import { describe, expect, it } from 'vitest';
import { patchHtmlForIframe } from '@/components/scene-renderers/interactive-renderer';

describe('patchHtmlForIframe', () => {
  it('injects error capture, storage shims, and layout patch into head', () => {
    const html = '<html><head><title>Widget</title></head><body><div>Hello</div></body></html>';

    const patched = patchHtmlForIframe(html);

    expect(patched).toContain('data-iframe-error-shim');
    expect(patched).toContain('data-iframe-storage-shim');
    expect(patched).toContain('data-iframe-patch');
    expect(patched).toContain('overflow-wrap: anywhere !important;');
    expect(patched).toContain('width: min(100%, 1120px) !important;');
    expect(patched).toContain(
      'grid-template-columns: minmax(220px, 320px) minmax(0, 1fr) !important;',
    );
    expect(patched).toContain('max-width: min(100%, 180px) !important;');
    expect(patched.indexOf('data-iframe-error-shim')).toBeLessThan(
      patched.indexOf('<title>Widget</title>'),
    );
  });

  it('prepends the injection when no head tag exists', () => {
    const html = '<div>bare widget</div>';

    const patched = patchHtmlForIframe(html);

    expect(patched.startsWith('\n<script data-iframe-error-shim>')).toBe(true);
    expect(patched).toContain(html);
  });
});
