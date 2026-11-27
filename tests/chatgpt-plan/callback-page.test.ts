import { describe, expect, it, vi } from 'vitest';
import { callbackPage } from '@/lib/server/chatgpt-plan/route';

vi.mock('server-only', () => ({}));

describe('loopback callback page', () => {
  it('uses the preferred supported language and keeps callback parameters out of the response', async () => {
    const request = new Request(
      'http://localhost/auth/callback?code=private-code&state=private-state',
      {
        headers: { 'accept-language': 'zh-TW, en;q=0.5' },
      },
    );
    const response = await callbackPage(request, { ok: false, reason: 'sign-in-expired' });
    const html = await response.text();
    expect(html).toContain('lang="zh-TW"');
    expect(html).toContain('未能完成 ChatGPT 登入');
    expect(html).not.toMatch(/private-code|private-state/);
    expect(html).toContain('history.replaceState');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
