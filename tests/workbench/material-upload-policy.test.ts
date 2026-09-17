import { describe, expect, it } from 'vitest';

import {
  isWorkbenchMaterialMime,
  resolveWorkbenchMaterialMime,
  WORKBENCH_MATERIAL_EXTENSIONS,
} from '@/lib/workbench/material-upload-policy';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('resolveWorkbenchMaterialMime', () => {
  it('keeps specific MIME types verbatim after alias normalization', () => {
    expect(resolveWorkbenchMaterialMime({ mimeType: 'application/pdf', fileName: 'a.pdf' })).toBe(
      'application/pdf',
    );
    expect(resolveWorkbenchMaterialMime({ mimeType: 'audio/x-m4a', fileName: 'clip.m4a' })).toBe(
      'audio/mp4',
    );
  });

  it('maps Kylin WPS Office MIME types to their canonical OOXML formats', () => {
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/wps-office.pptx',
        fileName: 'slides.pptx',
      }),
    ).toBe(PPTX_MIME);
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/wps-office.docx',
        fileName: 'lesson.docx',
      }),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/wps-office.xlsx',
        fileName: 'grades.xlsx',
      }),
    ).toBe(XLSX_MIME);
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/wps-office.unknown',
        fileName: 'slides.pptx',
      }),
    ).toBe('application/wps-office.unknown');
  });

  it('resolves a missing or generic MIME from the filename extension', () => {
    // Older Linux XDG mime databases report every OOXML file as the generic
    // Office container (#1497); empty, octet-stream, and zip-family types
    // need the same fallback the document path already grants them.
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/vnd.ms-office',
        fileName: 'slides.pptx',
      }),
    ).toBe(PPTX_MIME);
    expect(resolveWorkbenchMaterialMime({ mimeType: '', fileName: '讲义.pdf' })).toBe(
      'application/pdf',
    );
    expect(
      resolveWorkbenchMaterialMime({ mimeType: 'application/octet-stream', fileName: 'notes.md' }),
    ).toBe('text/markdown');
    expect(
      resolveWorkbenchMaterialMime({ mimeType: 'application/zip', fileName: 'book.xlsx' }),
    ).toBe(XLSX_MIME);
  });

  it('does not let a specific unknown MIME masquerade as a supported extension', () => {
    const resolved = resolveWorkbenchMaterialMime({
      mimeType: 'application/x-unknown',
      fileName: 'lesson.pdf',
    });
    expect(resolved).toBe('application/x-unknown');
    expect(isWorkbenchMaterialMime(resolved)).toBe(false);
  });

  it('keeps the generic MIME when the extension is not an accepted material', () => {
    const resolved = resolveWorkbenchMaterialMime({
      mimeType: 'application/vnd.ms-office',
      fileName: 'blob.bin',
    });
    expect(resolved).toBe('application/vnd.ms-office');
    expect(isWorkbenchMaterialMime(resolved)).toBe(false);
  });

  it('resolves uppercase extensions', () => {
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/vnd.ms-office',
        fileName: 'slides.PPTX',
      }),
    ).toBe(PPTX_MIME);
  });

  it('resolves every accepted extension to a whitelisted MIME (drift guard)', () => {
    // MIME_BY_EXTENSION is hand-maintained next to the extension list; if a
    // new extension joins the whitelist without a map entry (or with a value
    // outside the whitelist), generic-MIME uploads for it would silently 415
    // — the exact regression class this module exists to prevent.
    for (const extension of WORKBENCH_MATERIAL_EXTENSIONS) {
      const resolved = resolveWorkbenchMaterialMime({
        mimeType: 'application/octet-stream',
        fileName: `file${extension}`,
      });
      expect(resolved, extension).toBeTruthy();
      expect(isWorkbenchMaterialMime(resolved), extension).toBe(true);
    }
  });
});
