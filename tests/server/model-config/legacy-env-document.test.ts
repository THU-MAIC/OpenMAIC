/**
 * The document slot of a deployment configured only through the legacy
 * PDF_* provider variables (no openmaic.yml): the real provider loader,
 * translation and slot lookup, end to end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PDF_ENV = [
  'PDF_UNPDF_API_KEY',
  'PDF_UNPDF_BASE_URL',
  'PDF_MINERU_API_KEY',
  'PDF_MINERU_BASE_URL',
  'PDF_MINERU_CLOUD_API_KEY',
  'PDF_MINERU_CLOUD_BASE_URL',
  'ALIDOCMIND_ACCESS_KEY_ID',
  'ALIDOCMIND_ACCESS_KEY_SECRET',
  'ALIDOCMIND_BASE_URL',
  'OPENMAIC_CONFIG',
  'DEFAULT_MODEL',
  'MODEL_ROUTES',
  'MODEL_FALLBACK',
];

let dir: string;

beforeEach(() => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-legacy-document-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const name of PDF_ENV) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function documentServices() {
  const { resolveExtractionServices } = await import('@/lib/server/material-extraction/services');
  return resolveExtractionServices();
}

describe('document slot from the legacy provider variables', () => {
  it('resolves to self-hosted MinerU from its key and base URL', async () => {
    vi.stubEnv('PDF_MINERU_API_KEY', 'env-key');
    vi.stubEnv('PDF_MINERU_BASE_URL', 'https://mineru.example');
    const services = await documentServices();
    expect(services.documentStatus).toBe('default');
    expect(services.document).toMatchObject({
      providerId: 'mineru',
      apiKey: 'env-key',
      baseUrl: 'https://mineru.example',
      managed: true,
      origin: 'default',
    });
  });

  it('resolves to MinerU Cloud from its key alone, ahead of self-hosted MinerU', async () => {
    vi.stubEnv('PDF_MINERU_BASE_URL', 'https://mineru.example');
    vi.stubEnv('PDF_MINERU_CLOUD_API_KEY', 'cloud-key');
    const services = await documentServices();
    expect(services.document).toMatchObject({ providerId: 'mineru-cloud', apiKey: 'cloud-key' });
  });

  it('prefers MinerU over an unpdf entry listed before it', async () => {
    vi.stubEnv('PDF_UNPDF_BASE_URL', 'http://unpdf.example');
    vi.stubEnv('PDF_MINERU_BASE_URL', 'https://mineru.example');
    expect((await documentServices()).document).toMatchObject({ providerId: 'mineru' });
  });

  it('leaves the slot unassigned without the variable each service needs', async () => {
    // Self-hosted MinerU needs a base URL; MinerU Cloud needs a key.
    vi.stubEnv('PDF_MINERU_API_KEY', 'env-key');
    vi.stubEnv('PDF_MINERU_CLOUD_BASE_URL', 'https://mineru.net/api/v4');
    const services = await documentServices();
    expect(services.document).toBeNull();
    expect(services.documentStatus).toBe('unassigned');
  });

  it('lets openmaic.yml win over the variables', async () => {
    vi.stubEnv('PDF_MINERU_CLOUD_API_KEY', 'cloud-key');
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      [
        'providers:',
        '  mineru:',
        '    preset: mineru',
        '    baseUrl: https://mineru.yml.example',
        'slots:',
        '  document: mineru',
        '',
      ].join('\n'),
    );
    const services = await documentServices();
    // A server default from the file, not the legacy one: no legacy pins.
    expect(services.documentStatus).toBe('default');
    expect(services.document).toMatchObject({
      providerId: 'mineru',
      baseUrl: 'https://mineru.yml.example',
      origin: 'configuration',
      serverDefault: true,
    });
    expect(services.document?.apiKey).toBeUndefined();
  });
});
