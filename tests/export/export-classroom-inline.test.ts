import { describe, it, expect } from 'vitest';
import { inlineSceneContent } from '@/lib/export/use-export-classroom';

const fetchImpl = (async (_url: string) => {
  if (_url === 'https://cdn.tailwindcss.com')
    return new Response('/*tw*/', { status: 200, headers: { 'content-type': 'text/javascript' } });
  return new Response('', { status: 404 });
}) as unknown as typeof fetch;

type AnyContent = Record<string, unknown>;

describe('inlineSceneContent', () => {
  it('inlines external assets in an interactive scene content.html', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = {
      type: 'interactive',
      html: '<script src="https://cdn.tailwindcss.com"></script>',
      url: 'https://x',
    };
    const { content: out, report } = await inlineSceneContent(content, { fetchImpl });
    expect((out as unknown as AnyContent).html).toContain('data:text/javascript;base64,');
    expect((out as unknown as AnyContent).html).not.toContain('cdn.tailwindcss.com');
    expect(report.inlined).toContain('https://cdn.tailwindcss.com');
  });

  it('passes through non-interactive scenes untouched (same reference)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = { type: 'slide', elements: [] };
    const { content: out, report } = await inlineSceneContent(content, { fetchImpl });
    expect(out).toBe(content);
    expect(report.inlined).toEqual([]);
  });

  it('passes through interactive scenes with no html (url-only) untouched', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = { type: 'interactive', url: 'https://x' };
    const { content: out } = await inlineSceneContent(content, { fetchImpl });
    expect(out).toBe(content);
  });

  it('preserves other content fields while replacing html', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = {
      type: 'interactive',
      html: '<img src="https://cdn.tailwindcss.com">',
      widgetType: 'game',
      url: 'u',
    };
    const { content: out } = await inlineSceneContent(content, { fetchImpl });
    expect((out as unknown as AnyContent).widgetType).toBe('game');
    expect((out as unknown as AnyContent).url).toBe('u');
  });
});
