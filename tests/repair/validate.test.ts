import { describe, it, expect } from 'vitest';
import { validateStaticHtml } from '@/lib/repair/validators/static-html';
import { lintEmbeddedJs } from '@/lib/repair/validators/lint-js';

describe('validateStaticHtml', () => {
  it('passes well-formed html', async () => {
    const layer = await validateStaticHtml(
      '<!doctype html><html><body><div>ok</div></body></html>',
    );
    expect(layer.status).not.toBe('fail');
  });
  it('fails on a stray unclosed tag', async () => {
    const layer = await validateStaticHtml('<div><span></div>');
    expect(layer.status).toBe('fail');
    expect(layer.messages.length).toBeGreaterThan(0);
  });
});

describe('lintEmbeddedJs', () => {
  it('fails on a JS syntax error in a script block', async () => {
    const layer = await lintEmbeddedJs('<script>function(){</script>');
    expect(layer.status).toBe('fail');
    expect(layer.messages.length).toBeGreaterThan(0);
  });
  it('passes clean script', async () => {
    const layer = await lintEmbeddedJs('<script>function start(){ return 1; }</script>');
    expect(layer.status).not.toBe('fail');
  });
});
