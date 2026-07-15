/**
 * AliDocMind smoke tests (env-gated).
 *
 * Runs only when ALIDOCMIND_ACCESS_KEY_ID + ALIDOCMIND_ACCESS_KEY_SECRET are set.
 * Not part of CI; exercise locally to verify the AliDocMind adapter end-to-end.
 *
 *   export ALIDOCMIND_ACCESS_KEY_ID=xxx
 *   export ALIDOCMIND_ACCESS_KEY_SECRET=yyy
 *   npx vitest run tests/document/alidocmind.smoke.test.ts
 *
 * Note: the video case can occasionally fail even when the code is correct —
 * whether AliDocMind returns transcript/keyframes for a given public clip is
 * non-deterministic server-side. A re-run usually passes. It verifies the live
 * submit → poll → map path, not deterministic content.
 */

import { describe, it, expect } from 'vitest';

import { parsePDF } from '@/lib/pdf/pdf-providers';
import { parseMedia } from '@/lib/media-parse';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { MediaArtifact } from '@/lib/document';

const hasCreds =
  !!process.env.ALIDOCMIND_ACCESS_KEY_ID && !!process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
const describeIf = hasCreds ? describe : describe.skip;

const SAMPLE_PDF_URL =
  'https://gw.alipayobjects.com/os/basement_prod/598b9edf-5287-4065-9e36-464305c60698.pdf';
const SAMPLE_VIDEO_URL = 'https://media.w3.org/2010/05/sintel/trailer.mp4';

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

describeIf('AliDocMind smoke', () => {
  it(
    'parses a PDF into ParsedPdfContent with non-empty text',
    async () => {
      const buffer = await fetchBuffer(SAMPLE_PDF_URL);
      const result: ParsedPdfContent = await parsePDF(
        { providerId: 'alidocmind', allowEnvFallback: true },
        buffer,
        {
          fileName: 'sample.pdf',
          mimeType: 'application/pdf',
        },
      );
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.metadata?.parser).toBe('alidocmind');
    },
    5 * 60 * 1000,
  );

  it(
    'parses a video into MediaArtifact with transcript or keyframes',
    async () => {
      const buffer = await fetchBuffer(SAMPLE_VIDEO_URL);
      const artifact: MediaArtifact = await parseMedia({
        buffer,
        fileName: 'sample.mp4',
        mimeType: 'video/mp4',
        config: { providerId: 'alidocmind', allowEnvFallback: true },
      });
      const hasContent =
        (artifact.transcript && artifact.transcript.length > 0) ||
        (artifact.keyframes && artifact.keyframes.length > 0);
      expect(hasContent).toBe(true);
      expect(artifact.metadata.providerId).toBe('alidocmind');
      // Timestamps must be in milliseconds: a ~52s trailer should yield a
      // duration in the tens-of-thousands of ms, not tens (which would mean
      // the units were seconds). Guards against a silent ms/s mismatch.
      if (artifact.metadata.durationMs !== undefined) {
        expect(artifact.metadata.durationMs).toBeGreaterThan(1000);
      }
    },
    10 * 60 * 1000,
  );
});
