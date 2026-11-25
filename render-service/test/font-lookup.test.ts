import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  egressLockdownActive,
  unembeddedFamilies,
  withOfflineFontLookup,
} from '../src/font-lookup.js';

// Matches the URL Producer builds for a Google Fonts stylesheet lookup.
const lookup = (family: string) =>
  fetch(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,400;1,700`,
  );
const answer = () => {
  const delegate = vi.fn(async () => new Response('css', { status: 200 }));
  vi.stubGlobal('fetch', delegate);
  return delegate;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('answers lookups locally and records them per compilation', async () => {
  const delegate = answer();
  const [first, second] = await Promise.all([
    withOfflineFontLookup(async () => {
      await lookup('First Face');
      await delay(10);
      return (await lookup('Shared Face')).status;
    }),
    withOfflineFontLookup(async () => {
      await delay(5);
      await lookup('Second Face');
      await fetch('https://fonts.gstatic.com/s/face/v1/face.woff2');
      return (await lookup('Shared Face')).status;
    }),
  ]);
  expect(first.result).toBe(404);
  expect(first.requestedFamilies.sort()).toEqual(['First Face', 'Shared Face']);
  expect(second.result).toBe(404);
  expect(second.requestedFamilies.sort()).toEqual(['Second Face', 'Shared Face']);
  expect(delegate).not.toHaveBeenCalled();
});

it('passes other requests, such as the loopback file server, through unchanged', async () => {
  const server = createServer((_request, response) => response.end('served'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const { result, requestedFamilies } = await withOfflineFontLookup(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/index.html`);
      return { status: response.status, body: await response.text() };
    });
    expect(result).toEqual({ status: 200, body: 'served' });
    expect(requestedFamilies).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it('delegates outside a lookup scope, so strict callers fail as before', async () => {
  const delegate = answer();
  const { result } = await withOfflineFontLookup(() => lookup('Warm'));
  expect(result.status).toBe(404);
  expect((await lookup('Kanit')).status).toBe(200);
  expect(delegate).toHaveBeenCalledTimes(1);
});

it('reinstalls itself when another library replaces the global fetch', async () => {
  answer();
  await withOfflineFontLookup(() => lookup('Before'));
  const replaced = answer();
  const { result } = await withOfflineFontLookup(() => lookup('After'));
  expect(result.status).toBe(404);
  expect(replaced).not.toHaveBeenCalled();
});

it('treats a family as missing only when the compiled output has no face for it', () => {
  const compiled = `<html><head>
    <style data-hyperframes-deterministic-fonts="true">
      @font-face { font-family: "Calibri"; src: url("data:font/woff2;base64,AA") format("woff2"); }
      @font-face { font-family: "Inter"; src: url("data:font/woff2;base64,AA") format("woff2"); }
    </style>
    <style>@font-face { font-family: 'Packed Face'; src: url("face.woff2"); }</style>
    <style>p { font-family: "LXGW WenKai", sans-serif; }</style>
  </head></html>`;
  expect(
    unembeddedFamilies(compiled, ['Calibri', 'inter', 'Packed Face', 'LXGW WenKai', 'lxgw wenkai']),
  ).toEqual(['LXGW WenKai']);
});

it('ignores a stylesheet it cannot parse instead of failing the render', () => {
  const compiled = '<style>@font-face { font-family: "Broken"</style><style>p{}</style>';
  expect(unembeddedFamilies(compiled, ['Broken'])).toEqual(['Broken']);
});

it('treats only the entrypoint marker as an active lockdown', () => {
  expect(egressLockdownActive({ RENDER_EGRESS_LOCKDOWN_ACTIVE: 'true' })).toBe(true);
  // A service started without the entrypoint, e.g. `npm start`, keeps downloads.
  expect(egressLockdownActive({})).toBe(false);
  expect(egressLockdownActive({ RENDER_EGRESS_LOCKDOWN: 'true' })).toBe(false);
});
