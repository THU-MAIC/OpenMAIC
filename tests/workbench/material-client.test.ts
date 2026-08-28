import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkbenchSession,
  postWorkbenchMessage,
  uploadWorkbenchMaterial,
  WorkbenchMaterialUploadError,
} from '@/lib/workbench/session-store';
import { WORKBENCH_MATERIAL_ACCEPT } from '@/lib/workbench/material-upload-policy';

const material = {
  materialId: 'mat_00000000000000000000000000',
  name: '讲义.pdf',
  bytes: 5,
  mimeType: 'application/pdf',
  extractionStatus: 'idle' as const,
};

afterEach(() => vi.unstubAllGlobals());

describe('workbench material client', () => {
  it('offers the document, image, audio, and video material surface', () => {
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('application/pdf');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('text/csv');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('audio/mpeg');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('video/mp4');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('.m4a');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('.mov');
    expect(WORKBENCH_MATERIAL_ACCEPT).toContain('audio/x-m4a');
  });

  it('uploads composer files through POST /api/materials', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        materialId: material.materialId,
        originalName: material.name,
        bytes: material.bytes,
        mime: material.mimeType,
        extraction: { status: 'idle' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['hello'], material.name, { type: material.mimeType });
    await expect(uploadWorkbenchMaterial(file)).resolves.toEqual(material);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/materials',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/pdf',
          'x-material-filename': encodeURIComponent(material.name),
        }),
        body: file,
      }),
    );
  });

  it('preserves the response status for retryable upload failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'slow down' }, { status: 429 })),
    );
    const file = new File(['hello'], material.name, { type: material.mimeType });
    await expect(uploadWorkbenchMaterial(file)).rejects.toMatchObject({
      name: WorkbenchMaterialUploadError.name,
      message: 'slow down',
      status: 429,
    });
  });

  it('surfaces the upload request ID so a failed toast can be traced in logs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'material upload failed' },
          { status: 500, headers: { 'x-request-id': 'upload-trace-123' } },
        ),
      ),
    );
    const file = new File(['hello'], material.name, { type: material.mimeType });
    await expect(uploadWorkbenchMaterial(file)).rejects.toMatchObject({
      name: WorkbenchMaterialUploadError.name,
      message: 'material upload failed [requestId=upload-trace-123]',
      status: 500,
      requestId: 'upload-trace-123',
    });
  });

  it('sends only materialIds when creating a session', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 's1', stageId: 'stage-1', status: 'queued', prompt: 'p' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await createWorkbenchSession({ prompt: 'p', materials: [material] });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      prompt: 'p',
      materialIds: [material.materialId],
    });
    expect(String(request.body)).not.toContain('uploadId');
  });

  it('sends only materialIds on a follow-up message', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 's1' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await postWorkbenchMessage('s1', '继续', [material]);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      text: '继续',
      materialIds: [material.materialId],
    });
  });
});
