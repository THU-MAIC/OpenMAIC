#!/usr/bin/env node
'use strict';

// Run: TYPESCRIPT_PATH=/data/dev-codemate/aioj-core/node_modules/typescript node --test codemate-integration/test-tts.cjs
// Executes the actual bridge route with mocked server config/fetch; no provider requests or charges.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function findTypeScript() {
  for (const candidate of [
    process.env.TYPESCRIPT_PATH,
    'typescript',
    '/data/dev-codemate/aioj-core/node_modules/typescript',
  ].filter(Boolean)) {
    try {
      return require(candidate);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Set TYPESCRIPT_PATH to the installed typescript package directory.');
}
const ts = findTypeScript();
const routePath =
  process.env.OPENMAIC_TTS_ROUTE ||
  path.resolve(__dirname, '../app/api/access-code/codemate-tts/audio/speech/route.ts');
const compiled = ts.transpileModule(readFileSync(routePath, 'utf8'), {
  fileName: routePath,
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(
  (compiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error),
  [],
);

const SECRET = 'test_only_private_tts_secret_01234567890123456789';
const ENV = {
  CODEMATE_OPENMAIC_TTS_SECRET: SECRET,
  NOIZ_BASE_URL: 'https://noiz.example.test/v1/',
  NOIZ_API_KEY: 'test-only-noiz-key',
  NOIZ_VOICE_ID: 'server-selected-voice',
  TTS_OPENAI_MODELS: 'server-pinned-transport-model',
  TTS_OPENAI_ENABLED: 'true',
};
const FRAME = Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]),
  Buffer.alloc(1392),
]);
const TAG = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 9, 8, 7]);
function mp3(tag = true) {
  return new Response(tag ? Buffer.concat([TAG, FRAME]) : FRAME, {
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}
function loadRoute(fetchMock, options = {}) {
  const module = { exports: {} };
  const env = { ...ENV, ...options.env };
  const serverRequire = (id) => {
    if (id === '@/lib/audio/constants') return { DEFAULT_TTS_VOICES: { 'openai-tts': 'alloy' } };
    if (id === '@/lib/server/provider-config')
      return {
        isServerConfiguredProvider(section, provider) {
          assert.equal(section, 'tts');
          assert.equal(provider, 'openai-tts');
          return env.TTS_OPENAI_ENABLED !== 'false' && !!env.TTS_OPENAI_MODELS;
        },
        resolveTTSModel(provider, clientModel, voice) {
          assert.equal(provider, 'openai-tts');
          assert.equal(clientModel, undefined);
          assert.equal(voice, 'alloy');
          return env.TTS_OPENAI_MODELS?.split(',')[0].trim();
        },
      };
    if (id === 'node:crypto') return require(id);
    throw new Error('Unexpected actual-adapter import: ' + id);
  };
  vm.runInNewContext(
    compiled.outputText,
    {
      module,
      exports: module.exports,
      require: serverRequire,
      Buffer,
      URL,
      Request,
      Response,
      Headers,
      FormData,
      ReadableStream,
      AbortController,
      AbortSignal,
      TextEncoder,
      process: { env },
      fetch: fetchMock,
      setTimeout: options.setTimeout || setTimeout,
      clearTimeout,
    },
    { filename: routePath },
  );
  return module.exports;
}
function request(body = { input: '观察变量变化。' }, options = {}) {
  return new Request('http://localhost:13010/api/access-code/codemate-tts/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      ...options.headers,
    },
    body: options.raw === undefined ? JSON.stringify(body) : options.raw,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

test('requires an independent bearer credential before any provider request', async () => {
  let calls = 0;
  const route = loadRoute(async () => {
    calls++;
    return mp3();
  });
  for (const authorization of [
    '',
    'Bearer wrong-secret',
    `Basic ${SECRET}`,
    `Bearer ${SECRET} extra`,
  ]) {
    assert.equal(
      (await route.POST(request(undefined, { headers: { Authorization: authorization } }))).status,
      401,
    );
  }
  assert.equal(
    (
      await loadRoute(
        async () => {
          calls++;
        },
        { env: { CODEMATE_OPENMAIC_TTS_SECRET: '' } },
      ).POST(request())
    ).status,
    401,
  );
  assert.equal(calls, 0);
});

test('rejects invalid or excessive input and non-mp3 requests before billing', async () => {
  let calls = 0;
  const route = loadRoute(async () => {
    calls++;
    return mp3();
  });
  for (const body of [
    null,
    [],
    {},
    { input: ' ' },
    { input: 10 },
    { input: '中'.repeat(2001) },
    { input: 'hello', response_format: 'wav' },
    { input: 'hello', provider: 'caller-provider' },
    { input: 'hello', url: 'https://private.invalid' },
    { input: 'hello', model: 'caller-model' },
    { input: 'hello', voice: 'caller-voice' },
  ]) {
    assert.equal((await route.POST(request(body))).status, 400);
  }
  assert.equal((await route.POST(request(undefined, { raw: '{' }))).status, 400);
  assert.equal(
    (await route.POST(request(undefined, { headers: { 'Content-Type': 'text/plain' } }))).status,
    400,
  );
  assert.equal((await route.POST(request(undefined, { raw: ' '.repeat(16385) }))).status, 413);
  assert.equal(calls, 0);
});

test('uses the fixed parent bridge and server-owned speech contract without forwarding caller provider fields', async () => {
  const calls = [];
  const route = loadRoute(async (url, options) => {
    calls.push({ url, options });
    return mp3();
  });
  const response = await route.POST(
    request({
      input: '你好。',
      voice: ENV.NOIZ_VOICE_ID,
      model: ENV.TTS_OPENAI_MODELS,
      response_format: 'mp3',
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([TAG, FRAME]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18888/internal/classroom-tts');
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get('x-aioj-classroom-tts-token'), SECRET);
  assert.match(headers.get('x-aioj-tts-deadline'), /^\d{13}$/);
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('Cookie'), null);
  assert.equal(headers.get('Origin'), 'http://127.0.0.1:18888');
  assert.equal(headers.get('Referer'), 'http://127.0.0.1:18888/');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: '你好。', markdown: false });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('forwards the entire Unicode narration once and preserves returned MP3 bytes; core owns chunking', async () => {
  const texts = [];
  const input = '甲'.repeat(79) + '。' + '乙'.repeat(79) + '。' + '😀'.repeat(131) + '\n原题尾部  ';
  const route = loadRoute(async (_url, options) => {
    texts.push(JSON.parse(options.body).text);
    return mp3();
  });
  const response = await route.POST(request({ input }));
  assert.equal(response.status, 200);
  assert.deepEqual(texts, [input]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([TAG, FRAME]));
});

test('rejects bridge failures, redirects and malformed audio without leaking details or retrying', async () => {
  const providers = [
    {
      make: () => new Response('private-provider-message test-only-noiz-key', { status: 429 }),
      status: 429,
    },
    {
      make: () =>
        new Response('private-provider-message', {
          status: 302,
          headers: { Location: 'https://private.invalid' },
        }),
      status: 502,
    },
    { make: () => new Response('private-provider-message', { status: 504 }), status: 504 },
    {
      make: () =>
        new Response('{"private":"provider-error"}', {
          headers: { 'Content-Type': 'application/json' },
        }),
      status: 502,
    },
    {
      make: () => new Response('<html>bad</html>', { headers: { 'Content-Type': 'audio/mpeg' } }),
      status: 502,
    },
    {
      make: () =>
        new Response(Buffer.from('ID3invalid'), { headers: { 'Content-Type': 'audio/mpeg' } }),
      status: 502,
    },
    {
      make: () =>
        new Response(Buffer.from([255, 251, 144, 0]), {
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      status: 502,
    },
    {
      make: () => {
        throw new Error('private-provider-message');
      },
      status: 502,
    },
  ];
  for (const provider of providers) {
    let calls = 0;
    const route = loadRoute(async () => {
      calls++;
      return provider.make();
    });
    const response = await route.POST(request({ input: 'hello' }));
    assert.equal(response.status, provider.status);
    assert.doesNotMatch(await response.text(), /private|noiz-key|provider-error/);
    assert.equal(calls, 1);
  }
});

test('serializes requests and releases its slot after an upstream failure', async () => {
  let unblock;
  const blocker = new Promise((resolve) => {
    unblock = resolve;
  });
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  let inFlight = 0;
  let maximum = 0;
  const route = loadRoute(async () => {
    calls++;
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    if (calls === 1) {
      enter();
      await blocker;
      inFlight--;
      throw new Error('first failed');
    }
    inFlight--;
    return mp3(false);
  });
  const first = route.POST(request());
  await entered;
  const second = route.POST(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  unblock();
  assert.equal((await first).status, 502);
  assert.equal((await second).status, 200);
  assert.equal(maximum, 1);
});

test('aborted queued requests never reach the paid upstream', async () => {
  let unblock, enter;
  const blocker = new Promise((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const route = loadRoute(async () => {
    calls++;
    enter();
    await blocker;
    return mp3();
  });
  const first = route.POST(request());
  await entered;
  const controller = new AbortController();
  const second = route.POST(request(undefined, { signal: controller.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await second).status, 504);
  unblock();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test('enforces its total deadline including a stalled provider stream', async () => {
  let calls = 0;
  const route = loadRoute(
    async () => {
      calls++;
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    },
    { setTimeout: (callback, ms) => setTimeout(callback, ms === 150000 ? 20 : ms) },
  );
  const response = await route.POST(request());
  assert.equal(response.status, 504);
  assert.equal(calls, 1);
});

test('missing legacy voice no longer disables the parent preset, while missing server-managed model fails before a request', async () => {
  let calls = 0;
  const route = loadRoute(
    async () => {
      calls++;
      return mp3();
    },
    { env: { NOIZ_VOICE_ID: '' } },
  );
  assert.equal((await route.POST(request({ input: '旁白', voice: 'alloy' }))).status, 200);
  assert.equal(calls, 1);
  for (const env of [{ TTS_OPENAI_MODELS: '' }, { TTS_OPENAI_ENABLED: 'false' }]) {
    calls = 0;
    const unavailable = loadRoute(
      async () => {
        calls++;
        return mp3();
      },
      { env },
    );
    assert.equal((await unavailable.POST(request())).status, 503);
    assert.equal(calls, 0);
  }
});
