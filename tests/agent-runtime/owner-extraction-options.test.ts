/**
 * The settings the owner-level extraction cache key is built from, read from
 * the real server provider configuration: an extractor whose configured
 * endpoint, model or backend changes must get a different key, and nothing
 * secret may end up in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultResultOptions,
  ownerExtractionCacheKey,
} from '@/lib/server/material-extraction/owner-extraction';
import { resolveExtractionServices } from '@/lib/server/material-extraction/services';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

const SHA = 'a'.repeat(64);

async function keyFor(extractorId: string, config: ModelConfigFile) {
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
  const options = defaultResultOptions(extractorId, await resolveExtractionServices());
  return {
    options,
    key: ownerExtractionCacheKey(
      { sha256: SHA, mime: 'video/mp4' },
      { id: extractorId, version: '1' },
      options,
    ),
  };
}

function mineru(baseUrl: string): ModelConfigFile {
  return {
    providers: { pdf: { preset: 'mineru', baseUrl } },
    slots: { document: 'pdf' },
  };
}

function funasr(baseUrl: string, model: string): ModelConfigFile {
  return {
    providers: { speech: { preset: 'funasr-asr', baseUrl } },
    slots: { asr: `speech:${model}` },
  };
}

describe('owner extraction cache key settings', () => {
  beforeEach(() => vi.stubEnv('PDF_MINERU_BACKEND', ''));

  afterEach(() => {
    setDeploymentConfigForTests();
    vi.unstubAllEnvs();
  });

  it('keys local media on the ASR endpoint, not only its provider and model', async () => {
    const a = await keyFor(
      'local-ffmpeg',
      funasr('http://asr-a.example.com:8000/v1/', 'transcriber'),
    );
    const b = await keyFor(
      'local-ffmpeg',
      funasr('http://asr-b.example.com:8000/v1', 'transcriber'),
    );
    expect(a.options).toEqual({
      asrProvider: 'funasr-asr',
      asrModel: 'transcriber',
      asrEndpoint: 'http://asr-a.example.com:8000/v1',
    });
    expect(b.options.asrEndpoint).toBe('http://asr-b.example.com:8000/v1');
    expect(a.key).not.toBe(b.key);

    const otherModel = await keyFor(
      'local-ffmpeg',
      funasr('http://asr-a.example.com:8000/v1', 'transcriber-large'),
    );
    expect(otherModel.key).not.toBe(a.key);
  });

  it('keys self-hosted MinerU on its endpoint and backend', async () => {
    const pipeline = await keyFor('mineru', mineru('http://mineru-a:8000'));
    vi.stubEnv('PDF_MINERU_BACKEND', 'vlm');
    const vlm = await keyFor('mineru', mineru('http://mineru-a:8000'));
    vi.stubEnv('PDF_MINERU_BACKEND', '');
    const elsewhere = await keyFor('mineru', mineru('http://mineru-b:8000'));
    expect(pipeline.options).toEqual({ endpoint: 'http://mineru-a:8000', backend: 'pipeline' });
    expect(new Set([pipeline.key, vlm.key, elsewhere.key]).size).toBe(3);
  });

  it('keeps credentials out of the endpoint', async () => {
    const { options } = await keyFor(
      'mineru',
      mineru('https://operator:s3cret@mineru.example/api?token=abc#x'),
    );
    expect(options.endpoint).toBe('https://mineru.example/api');
    expect(JSON.stringify(options)).not.toMatch(/s3cret|token=abc|operator/);
  });

  it('keys an endpoint on its other query parameters, but not on credential ones', async () => {
    const at = (query: string) => keyFor('mineru', mineru(`http://mineru:8000/api${query}`));
    const plain = await at('');
    const small = await at('?model=small');
    const large = await at('?model=large');
    expect(new Set([plain.key, small.key, large.key]).size).toBe(3);
    expect(small.options.endpoint).not.toMatch(/small/);
    const reordered = await at('?b=2&model=small&a=1');
    expect((await at('?a=1&model=small&b=2')).key).toBe(reordered.key);
    const keyed = await at('?model=small&api_key=k1&Signature=s1');
    expect(keyed.key).toBe(small.key);
    expect((await at('?model=small&api_key=k2&Signature=s2')).key).toBe(small.key);
    expect(JSON.stringify(keyed.options)).not.toMatch(/k1|s1/);
  });

  it('keys Azure ASR on the api-version it sends, including the default one', async () => {
    const host = 'https://eastus.api.cognitive.microsoft.com';
    const azure = (path: string) =>
      keyFor('local-ffmpeg', {
        providers: {
          speech: { preset: 'azure-asr', apiKey: 'azure-key', baseUrl: `${host}${path}` },
        },
        slots: { asr: 'speech' },
      });
    const unset = await azure('');
    // A base URL with the path already in it is how an api-version is set.
    const query = (params: string) => `/speechtotext/transcriptions:transcribe?${params}`;
    expect(unset.options.asrProvider).toBe('azure-asr');
    expect(unset.options.asrEndpoint).toMatch(
      /^https:\/\/eastus\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe\?sha256:/,
    );
    // No api-version is sent as the default one, so it keys the same.
    expect((await azure(query('api-version=2025-10-15'))).key).toBe(unset.key);
    const older = await azure(query('api-version=2024-11-15'));
    expect(older.key).not.toBe(unset.key);
    expect((await azure(query('api-version=2024-11-15&subscription-key=other-key'))).key).toBe(
      older.key,
    );
    expect(JSON.stringify(unset.options)).not.toMatch(/azure-key/);
  });

  it('keys the same bytes under different MIME types apart', async () => {
    const extractor = { id: 'local-ffmpeg', version: '1' };
    expect(ownerExtractionCacheKey({ sha256: SHA, mime: 'audio/webm' }, extractor, {})).not.toBe(
      ownerExtractionCacheKey({ sha256: SHA, mime: 'video/webm' }, extractor, {}),
    );
  });

  it('gives an extractor without configured settings an empty set', async () => {
    expect((await keyFor('unpdf', {})).options).toEqual({});
  });
});
