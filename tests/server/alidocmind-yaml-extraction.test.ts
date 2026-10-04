import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentExtractorInput, DocumentExtractorProvider } from '@/lib/document';

// Only server-providers.yml is faked; every other file read is real.
const yaml = vi.hoisted(() => ({ content: null as string | null }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  const existsSync = (p: string) => (isYaml(p) ? yaml.content !== null : actual.existsSync(p));
  const readFileSync = (p: string, ...args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isYaml(p) ? (yaml.content ?? '') : (actual.readFileSync as any)(p, ...args);
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('YAML-only AliDocMind for classroom materials', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ['ALIDOCMIND_ACCESS_KEY_ID', 'ALIDOCMIND_ACCESS_KEY_SECRET']) {
      vi.stubEnv(key, '');
    }
    yaml.content = 'pdf:\n  alidocmind:\n    accessKeyId: yaml-ak\n    accessKeySecret: yaml-sk\n';
  });

  it('is advertised as extractable and extraction receives the managed key pair', async () => {
    const { resolveExtractableMimeTypes } =
      await import('@/lib/server/material-extraction/availability');
    const { extractMaterialSource } = await import('@/lib/server/material-extraction/extract');

    const extractable = await resolveExtractableMimeTypes({ mediaProviders: () => [] });
    expect(extractable.has(DOCX)).toBe(true);

    const extract = vi.fn(async (input: DocumentExtractorInput) => ({
      metadata: { mimeType: input.mimeType, providerId: 'alidocmind' },
      blocks: [{ id: 'b1', type: 'text' as const, text: 'Extracted text' }],
      assets: [],
    }));
    const alidocmind = {
      id: 'alidocmind',
      displayName: 'AliDocMind',
      version: '1',
      supportedMimeTypes: [DOCX],
      requiresServiceConfig: true,
      capabilities: {
        text: true,
        images: true,
        tables: true,
        formulas: true,
        layout: true,
        ocr: true,
        async: true,
      },
      extract,
    } as unknown as DocumentExtractorProvider;

    const result = await extractMaterialSource(
      { bytes: Buffer.from('docx'), mime: DOCX, fileName: 'notes.docx' },
      { providers: () => [alidocmind], mediaProviders: () => [] },
    );

    expect(result.text).toBe('Extracted text');
    expect(extract.mock.calls[0][0].config).toMatchObject({
      providerId: 'alidocmind',
      accessKeyId: 'yaml-ak',
      accessKeySecret: 'yaml-sk',
      managed: true,
    });
  });
});
