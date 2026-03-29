import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { generateWithSora } from './sora-adapter.ts';

async function testSoraProviderConfig() {
  const videoProvidersSource = await readFile(
    new URL('../video-providers.ts', import.meta.url),
    'utf8',
  );

  assert.match(videoProvidersSource, /supportedDurations:\s*\[4,\s*8,\s*12\]/);
  assert.match(videoProvidersSource, /maxDuration:\s*12/);
}

async function testGenerateWithSoraSeconds() {
  const originalFetch = globalThis.fetch;
  let submittedSeconds = null;

  try {
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/videos')) {
        assert.equal(init?.method, 'POST');
        assert.ok(init?.body instanceof FormData);
        submittedSeconds = init.body.get('seconds');

        return new Response(
          JSON.stringify({
            id: 'vid_123',
            status: 'failed',
            error: { message: 'stop after submit' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      throw new Error(`Unexpected fetch target: ${String(input)}`);
    };

    await assert.rejects(
      generateWithSora(
        {
          providerId: 'sora',
          apiKey: 'test-key',
        },
        {
          prompt: 'A short cinematic clip',
          duration: 7,
        },
      ),
      /stop after submit/,
    );

    assert.equal(submittedSeconds, '8');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await testSoraProviderConfig();
  await testGenerateWithSoraSeconds();
  console.log('Sora duration regression tests passed.');
}

await main();
