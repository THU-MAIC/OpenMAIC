import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every response of a request whose owner was resolved carries the
 * resolution's `Set-Cookie` values: the anonymous owner a request minted, or
 * the renewal of the one it presented (the anonymous identity expires only
 * after 400 days without use because of that renewal). `withRequestOwner`
 * does it for its routes. Code that resolves the owner itself must forward
 * them, or an identity used only through it silently stops being renewed.
 *
 * The scan finds every module outside `lib/server/identity/` that calls the
 * resolution directly (or the asset helper that wraps it) and requires the
 * forwarding each kind needs. A new direct caller fails here until it
 * forwards, or is listed below with the reason it cannot.
 */

const ROOT = join(__dirname, '..', '..', '..');
const SCANNED = ['app', 'lib', 'components'];
const SOURCE = /\.(ts|tsx)$/;
const IDENTITY_MODULE = ['lib', 'server', 'identity'].join(sep) + sep;

function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path);
  if (statSync(absolute).isFile()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(absolute).flatMap((entry) =>
    entry === 'node_modules' ? [] : sourceFiles(join(path, entry)),
  );
}

const files = SCANNED.flatMap(sourceFiles)
  .filter((file) => !file.startsWith(IDENTITY_MODULE))
  .map((file) => ({
    file: relative(ROOT, join(ROOT, file)),
    text: readFileSync(join(ROOT, file), 'utf8'),
  }));

const callers = (call: RegExp) => files.filter(({ text }) => call.test(text));

/**
 * Callers that cannot forward, each with the reason. Keep this short: the
 * fix is almost always to forward.
 */
const EXEMPT: Record<string, string> = {
  // Server Action: `requireContextOwner` renews through next/headers itself.
  [join('lib', 'workbench', 'workspace-actions.ts')]: 'Server Action (renews via next/headers)',
  // Resolves image ids into a generation prompt and returns no response of
  // its own; its routes are generation streams that never answered with owner
  // cookies. Renewal there is left to the owner-scoped routes the same page
  // calls (the library, persistence), which every session uses.
  [join('lib', 'persistence', 'resolve-vision-images.ts')]: 'prompt helper, no response',
};

describe('owner resolution cookies are forwarded', () => {
  it('scans a non-trivial tree and finds the known direct callers', () => {
    expect(files.length).toBeGreaterThan(100);
    const direct = callers(/\bresolveRequestOwner\(/).map(({ file }) => file);
    expect(direct).toEqual(
      expect.arrayContaining([
        join('app', 'api', 'chat', 'pi', 'route.ts'),
        join('app', 'api', 'chat', 'pi', 'whiteboard-visibility', 'route.ts'),
        join('lib', 'persistence', 'resolve-server-asset.ts'),
      ]),
    );
  });

  it('every direct resolveRequestOwner caller forwards setCookies', () => {
    const offenders = callers(/\bresolveRequestOwner\(/)
      .filter(({ file }) => !(file in EXEMPT))
      .filter(({ text }) => {
        const attaches = /attachOwnerCookies\([\s\S]*?setCookies\)/.test(text);
        const handsBack = /setCookies:\s*outcome\.setCookies/.test(text);
        return !attaches && !handsBack;
      })
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('every authenticateRequestOwner caller answers with its responseHeaders', () => {
    const offenders = callers(/\bauthenticateRequestOwner\(/)
      .filter(({ file }) => !(file in EXEMPT))
      .filter(({ text }) => !/\bresponseHeaders\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('every resolveServerAsset caller attaches the cookies it hands back', () => {
    const offenders = callers(/\bresolveServerAsset\(/)
      .filter(({ file }) => file !== join('lib', 'persistence', 'resolve-server-asset.ts'))
      .filter(({ file }) => !(file in EXEMPT))
      .filter(({ text }) => !(/attachOwnerCookies\(/.test(text) && /\.setCookies\b/.test(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('lists no exemption that no longer calls the resolution', () => {
    for (const file of Object.keys(EXEMPT)) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text).toMatch(/resolveRequestOwner\(|requireContextOwner\(|resolveServerAsset\(/);
    }
  });
});

const COOKIE = '66666666-6666-4666-8666-666666666666';
const RENEWAL = new RegExp(`^anonymous_id=${COOKIE}; .*Max-Age=34560000`);

function post(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `anonymous_id=${COOKIE}` },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('the Pi routes renew the anonymous owner', () => {
  beforeEach(() => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');
  });
  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    vi.unstubAllEnvs();
  });

  it('on whiteboard visibility answers, errors included', async () => {
    const { POST } = await import('@/app/api/chat/pi/whiteboard-visibility/route');
    const invalid = await POST(post('http://localhost/api/chat/pi/whiteboard-visibility', {}));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.getSetCookie()).toEqual([expect.stringMatching(RENEWAL)]);
    const unknown = await POST(
      post('http://localhost/api/chat/pi/whiteboard-visibility', {
        queryId: 'q',
        stageId: 's',
        visibility: 'open',
      }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.getSetCookie()).toEqual([expect.stringMatching(RENEWAL)]);
  });

  it('on Pi chat answers, errors included', async () => {
    const { POST } = await import('@/app/api/chat/pi/route');
    const invalid = await POST(post('http://localhost/api/chat/pi', { storeState: {} }));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.getSetCookie()).toEqual([expect.stringMatching(RENEWAL)]);
  });

  it('puts the cookies on a streaming answer before its body is read', async () => {
    const { attachOwnerCookies } = await import('@/lib/server/identity/with-owner');
    let pulled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
        controller.close();
      },
    });
    const renewal = `anonymous_id=${COOKIE}; Path=/; Max-Age=34560000`;
    const response = attachOwnerCookies(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      [renewal],
    );
    expect(response.headers.getSetCookie()).toEqual([renewal]);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(pulled).toBe(false);
    expect(await response.text()).toBe('data: 1\n\n');
  });
});
