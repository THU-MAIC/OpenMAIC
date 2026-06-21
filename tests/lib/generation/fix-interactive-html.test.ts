import { describe, expect, it, vi } from 'vitest';
import { fixInteractiveHtml } from '@/lib/generation/fix-interactive-html';

const BROKEN = '<!DOCTYPE html><html><head></head><body><button id="go">Go</button></body></html>';
const FIXED =
  '<!DOCTYPE html><html><head></head><body><button id="go">Go</button>' +
  '<script>document.getElementById("go").addEventListener("click",()=>{});</script></body></html>';

describe('fixInteractiveHtml', () => {
  it('sends the bug + current html and returns the post-processed fixed html', async () => {
    let seenUser = '';
    const aiCall = vi.fn(async (_system: string, user: string) => {
      seenUser = user;
      return FIXED;
    });

    const result = await fixInteractiveHtml(BROKEN, 'the Go button does nothing', aiCall);

    expect(aiCall).toHaveBeenCalledOnce();
    // user prompt carried both the description and the current HTML
    expect(seenUser).toContain('the Go button does nothing');
    expect(seenUser).toContain('<button id="go">Go</button>');
    // returned html contains the fix
    expect(result).toContain('addEventListener');
    // post-processing injected KaTeX (no katex present in the model output)
    expect(result?.toLowerCase()).toContain('katex');
  });

  it('returns null when no HTML can be extracted from the response', async () => {
    const aiCall = vi.fn(async () => 'Sorry, I cannot help with that.');
    const result = await fixInteractiveHtml(BROKEN, 'broken', aiCall);
    expect(result).toBeNull();
  });
});
