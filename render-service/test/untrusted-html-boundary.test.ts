import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));

const executable =
  process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

// Every hit the local listener recorded for the currently running scenario.
const hits: string[] = [];
let server: Server;
let httpUrl = '';
let wsUrl = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? '/');
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'text/plain',
    });
    response.end('ok');
  });
  // A WebSocket handshake arrives as an upgrade, never as a normal request.
  server.on('upgrade', (request, socket) => {
    hits.push(`upgrade:${request.url ?? '/'}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runScenario(scenario: string): Promise<Record<string, unknown>> {
  hits.length = 0;
  const { stdout } = await execute(
    process.execPath,
    ['--import', 'tsx', 'test/untrusted-html-boundary.fixture.mjs', scenario],
    {
      cwd,
      timeout: 90_000,
      env: { ...process.env, CSP_TEST_HTTP_URL: httpUrl, CSP_TEST_WS_URL: wsUrl },
    },
  );
  // The child closes Chromium before printing, so give the listener a beat.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

// The negative controls run last: they intentionally reach the listener, and
// ordering them after the zero-hit cases keeps a late request from a bypass
// from masquerading as a policy failure.
describe.skipIf(!executable)('untrusted HTML network boundary in real Chromium', () => {
  it('keeps every network vector out of a preview interactive frame', async () => {
    const result = await runScenario('preview-after-head');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('keeps a payload placed before <head> out too', async () => {
    const result = await runScenario('preview-before-head');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('completes the full preview renderer path for a non-navigating payload', async () => {
    const result = await runScenario('preview-full-path');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('ignores a permissive attacker CSP meta because policies intersect', async () => {
    const result = await runScenario('preview-attacker-meta');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('keeps a /render index.html from reaching the listener', async () => {
    const result = await runScenario('render-payload');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it.each([
    ['NBSP', 'preview-prefix-nbsp'],
    ['a BOM', 'preview-prefix-bom'],
    ['two BOMs', 'preview-prefix-2bom'],
    ['U+3000', 'preview-prefix-ideographic'],
  ])(
    'keeps every vector out of a preview frame prefixed with %s',
    async (_name, scenario) => {
      const result = await runScenario(scenario);
      expect(result.ok).toBe(true);
      expect(hits).toEqual([]);
    },
    120_000,
  );

  it('keeps a /render index.html that starts with NBSP from reaching the listener', async () => {
    const result = await runScenario('render-prefix-nbsp-index');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('keeps a nested /render scene that starts with NBSP from reaching the listener', async () => {
    const result = await runScenario('render-prefix-nbsp-scene');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('blocks fetch, img, WebSocket and a foreignObject iframe inside a hardened .svg', async () => {
    const result = await runScenario('render-svg');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('blocks a sanitized .xhtml served as application/xhtml+xml', async () => {
    const result = await runScenario('render-xhtml');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('blocks GET and POST form submissions through form-action', async () => {
    const result = await runScenario('render-form');
    expect(result.ok).toBe(true);
    expect(hits).toEqual([]);
  }, 120_000);

  it('still renders a representative packaged export under the policy', async () => {
    const result = await runScenario('render-legit');
    expect(result.ok).toBe(true);
    expect(result.scene).toMatchObject({
      appScriptLoaded: true,
      inlineOk: true,
      shapeBackground: 'rgb(225, 29, 72)',
      shapeWidth: 240,
      pixelLoaded: true,
      sceneOk: true,
      sceneText: 'scene',
      sceneBackground: 'rgb(34, 197, 94)',
    });
  }, 120_000);

  it('proves the preview negative control reaches the listener when bypassed', async () => {
    const result = await runScenario('preview-bypass');
    expect(result.ok).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  it('proves the render negative control reaches the listener when bypassed', async () => {
    const result = await runScenario('render-bypass');
    expect(result.ok).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  it('proves the .svg negative control reaches the listener when sanitization is bypassed', async () => {
    const result = await runScenario('render-svg-bypass');
    expect(result.ok).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  it('proves the .xhtml negative control reaches the listener when sanitization is bypassed', async () => {
    const result = await runScenario('render-xhtml-bypass');
    expect(result.ok).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);
});
