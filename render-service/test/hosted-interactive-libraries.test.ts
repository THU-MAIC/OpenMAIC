import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  HostedInteractiveLibraries,
  INTERACTIVE_PREVIEW_ORIGIN,
} from '../src/hosted-interactive-libraries.js';
import { installPreviewRequestGuard } from '../src/preview-renderer.js';

const library = 'katex@0.16.38';
const path = `/vendor/interactive/${library}`;
const url = `${INTERACTIVE_PREVIEW_ORIGIN}${path}`;
const mirrorBase = 'https://assets.example.test/interactive';
let directory: string;

async function writeAsset(file: string, body: string | Buffer) {
  const target = join(directory, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'interactive-libraries-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function intercept() {
  const mainFrame = {};
  const subframe = {};
  const handlers = new Set<(request: HTTPRequest) => Promise<void>>();
  const page = {
    mainFrame: () => mainFrame,
    setRequestInterception: vi.fn(),
    on: (_event: string, handler: (request: HTTPRequest) => Promise<void>) => handlers.add(handler),
    off: (_event: string, handler: (request: HTTPRequest) => Promise<void>) =>
      handlers.delete(handler),
  };
  const dispose = await installPreviewRequestGuard(
    page as unknown as Page,
    new HostedInteractiveLibraries(directory, mirrorBase),
  );
  expect(page.setRequestInterception).toHaveBeenCalledWith(true);

  return {
    dispose,
    async request(url: string, { main = false, navigate = false, method = 'GET' } = {}) {
      const request = {
        frame: () => (main ? mainFrame : subframe),
        url: () => url,
        isNavigationRequest: () => navigate,
        method: () => method,
        isInterceptResolutionHandled: () => false,
        respond: vi.fn(),
        abort: vi.fn().mockResolvedValue(undefined),
        continue: vi.fn().mockResolvedValue(undefined),
      };
      for (const handler of handlers) await handler(request as unknown as HTTPRequest);
      return request;
    },
  };
}

it('responds from disk with MIME types and CORS for the default and configured bases', async () => {
  const font = Buffer.from([0, 128, 255]);
  const css = 'body { color: red }';
  const js = 'globalThis.tailwind = {};';
  await writeAsset(`${library}/dist/fonts/face.woff2`, font);
  await writeAsset(`${library}/dist/katex.min.css`, css);
  await writeAsset('@tailwindcss/browser@4.1.18/dist/index.global.js', js);
  const guard = await intercept();
  try {
    for (const [address, contentType, body] of [
      [`${url}/dist/fonts/face.woff2`, 'font/woff2', font],
      [`${mirrorBase}/${library}/dist/katex.min.css`, 'text/css', Buffer.from(css)],
      [
        `${INTERACTIVE_PREVIEW_ORIGIN}/vendor/interactive/@tailwindcss/browser@4.1.18/dist/index.global.js`,
        'text/javascript',
        Buffer.from(js),
      ],
    ] as const) {
      const request = await guard.request(address);
      expect(request.respond).toHaveBeenCalledExactlyOnceWith({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType,
        body,
      });
      expect(request.abort).not.toHaveBeenCalled();
      expect(request.continue).not.toHaveBeenCalled();
    }
  } finally {
    guard.dispose();
  }
});

it('aborts misses, traversal, other origins and disallowed methods or navigations', async () => {
  await writeAsset(`${library}/dist/katex.min.js`, 'fixture');
  await writeAsset('unknown@1.0.0/index.js', 'unknown package');
  await writeAsset('outside.js', 'outside the library');
  await symlink(join(directory, 'outside.js'), join(directory, library, 'escape.js'));
  const guard = await intercept();
  try {
    for (const [address, options] of [
      [`${url}/dist/missing.js`],
      [`${url}/%2e%2e/outside.js`],
      [`${url}/dist%2f..%2f..%2foutside.js`],
      [`${url}/dist%5ckatex.min.js`],
      [`${url}/%00.js`],
      [`${url}/%invalid.js`],
      [`${url}/escape.js`],
      [`${url}/dist/katex.min.js?v=1`],
      [`${INTERACTIVE_PREVIEW_ORIGIN}/vendor/interactive/unknown@1.0.0/index.js`],
      [`https://unrelated.example.test${path}/dist/katex.min.js`],
      [`${INTERACTIVE_PREVIEW_ORIGIN}/private.js`],
      [`${INTERACTIVE_PREVIEW_ORIGIN}/private.js`, { main: true, navigate: true }],
      [`${url}/dist/katex.min.js`, { navigate: true }],
      [`${url}/dist/katex.min.js`, { method: 'POST' }],
    ] as const) {
      const request = await guard.request(address, options);
      expect(request.abort, address).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
      expect(request.respond, address).not.toHaveBeenCalled();
      expect(request.continue, address).not.toHaveBeenCalled();
    }
  } finally {
    guard.dispose();
  }
});

it('continues the existing local schemes and trusted main-frame subresources', async () => {
  const guard = await intercept();
  for (const [address, options] of [
    ['data:text/plain,ok'],
    ['blob:null/example'],
    ['about:srcdoc', { navigate: true }],
    ['about:blank', { main: true, navigate: true }],
    ['https://example.test/image.png', { main: true }],
  ] as const) {
    const request = await guard.request(address, options);
    expect(request.continue, address).toHaveBeenCalledOnce();
    expect(request.abort, address).not.toHaveBeenCalled();
    expect(request.respond, address).not.toHaveBeenCalled();
  }
  guard.dispose();
  const request = await guard.request('data:text/plain,ok');
  expect(request.continue).not.toHaveBeenCalled();
});
