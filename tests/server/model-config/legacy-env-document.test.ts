/**
 * Document configuration before and after moving provider settings to openmaic.yml.
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
  'PDF_MINICPM_OCR_API_KEY',
  'PDF_MINICPM_OCR_BASE_URL',
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

describe('document slot migration', () => {
  it('leaves the document slot unassigned even when old credentials are complete', async () => {
    vi.stubEnv('PDF_MINERU_API_KEY', 'env-key');
    vi.stubEnv('PDF_MINERU_BASE_URL', 'https://mineru.example');
    vi.stubEnv('ALIDOCMIND_ACCESS_KEY_ID', 'legacy-id');
    vi.stubEnv('ALIDOCMIND_ACCESS_KEY_SECRET', 'legacy-secret');
    expect((await documentServices()).documentStatus).toBe('unassigned');
  });

  it('leaves the slot unassigned without the variable each service needs', async () => {
    // Self-hosted MinerU needs a base URL; MinerU Cloud needs a key.
    vi.stubEnv('PDF_MINERU_API_KEY', 'env-key');
    vi.stubEnv('PDF_MINERU_CLOUD_BASE_URL', 'https://mineru.net/api/v4');
    const services = await documentServices();
    expect(services.document).toBeNull();
    expect(services.documentStatus).toBe('unassigned');
  });

  it('accepts a keyless self-hosted MiniCPM-OCR from openmaic.yml', async () => {
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      [
        'providers:',
        '  ocr:',
        '    preset: minicpm-ocr',
        '    baseUrl: http://ocr.internal/api',
        'slots:',
        '  document: ocr',
        '',
      ].join('\n'),
    );
    const services = await documentServices();
    expect(services.documentStatus).toBe('configured');
    expect(services.document).toMatchObject({
      providerId: 'minicpm-ocr',
      baseUrl: 'http://ocr.internal/api',
      origin: 'configuration',
    });
    expect(services.document?.apiKey).toBeUndefined();
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
    expect(services.documentStatus).toBe('configured');
    expect(services.document).toMatchObject({
      providerId: 'mineru',
      baseUrl: 'https://mineru.yml.example',
      origin: 'configuration',
    });
    expect(services.document?.apiKey).toBeUndefined();
  });
});
