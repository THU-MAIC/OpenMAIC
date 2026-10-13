import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import { retryMaterialUpload } from '@/lib/workbench/material-upload-scheduling';

const capabilitiesUrl = '/api/generate-classroom/capabilities';
const uploadUrl = '/api/materials?extract=false';
const MiB = 1024 * 1024;

let client: typeof import('@/lib/workbench/session-store');

beforeEach(async () => {
  // A fresh module import models a new page load, so no reset hook is needed.
  vi.resetModules();
  client = await import('@/lib/workbench/session-store');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function file(name = 'lecture.pdf', type = 'application/pdf', bytes = 5): File {
  const result = new File(['hello'], name, { type });
  Object.defineProperty(result, 'size', { value: bytes });
  return result;
}

function uploaded(): Response {
  return Response.json({ materialId: 'mat_test' });
}

function stubPolicy(materials: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    input === capabilitiesUrl ? Response.json({ materials }) : uploaded(),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('workbench material upload size precheck', () => {
  it('rejects an oversized document with the advertised cap before POSTing any bytes', async () => {
    const maxBytes = 12.5 * MiB;
    const fetchMock = stubPolicy({ maxDocumentBytes: maxBytes, maxMediaBytes: 100 * MiB });
    const error = await client
      .uploadWorkbenchMaterial(file('lecture.pdf', 'application/pdf', maxBytes + 1))
      .catch((error) => error);

    expect(error).toBeInstanceOf(client.WorkbenchMaterialUploadError);
    expect(error).toMatchObject({ status: 413, maxBytes });
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
      'File too large. Please select a file no larger than 12.5 MB.',
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(capabilitiesUrl, { cache: 'no-store' });
  });

  it.each([
    ['lecture.pdf', 'application/pdf', false],
    ['picture.png', 'image/png', false],
    ['slides.pptx', 'application/vnd.ms-office', false],
    ['video.mp4', 'video/mp4', true],
    ['audio.m4a', 'audio/x-m4a', true],
    ['audio.wav', 'audio/x-wav', true],
    ['video.mov', 'application/octet-stream', true],
    ['audio.webm', 'audio/webm', true],
  ])('uses the resolved MIME to choose the cap for %s (%s)', async (name, type, media) => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 4, maxMediaBytes: 10 });
    const pending = client.uploadWorkbenchMaterial(file(name, type));
    if (media) {
      await expect(pending).resolves.toMatchObject({ materialId: 'mat_test' });
      expect(fetchMock).toHaveBeenCalledWith(
        uploadUrl,
        expect.objectContaining({ method: 'POST' }),
      );
    } else {
      await expect(pending).rejects.toMatchObject({ status: 413, maxBytes: 4 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves an oversized unsupported type to the server so its 415 is preserved', async () => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 4, maxMediaBytes: 4 });
    await expect(
      client.uploadWorkbenchMaterial(file('archive.zip', 'application/zip', 100)),
    ).resolves.toMatchObject({ materialId: 'mat_test' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(uploadUrl, expect.anything());
  });

  it('rejects media against maxMediaBytes even when the document cap is higher', async () => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 10, maxMediaBytes: 4 });
    await expect(
      client.uploadWorkbenchMaterial(file('audio.mp3', 'audio/mpeg')),
    ).rejects.toMatchObject({
      status: 413,
      maxBytes: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([4, 5])('uploads a document of %s bytes at or below the cap', async (bytes) => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 5, maxMediaBytes: 10 });
    const selected = file('lecture.pdf', 'application/pdf', bytes);
    await expect(client.uploadWorkbenchMaterial(selected)).resolves.toMatchObject({
      materialId: 'mat_test',
      bytes,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      uploadUrl,
      expect.objectContaining({ method: 'POST', body: selected }),
    );
  });

  it('honors deployment caps above the default instead of imposing a browser constant', async () => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 100 * MiB, maxMediaBytes: 200 * MiB });
    await expect(
      client.uploadWorkbenchMaterial(file('lecture.pdf', 'application/pdf', 80 * MiB)),
    ).resolves.toMatchObject({ materialId: 'mat_test' });
    expect(fetchMock).toHaveBeenCalledWith(uploadUrl, expect.anything());
  });

  it.each(['network', 'http', 'json'])(
    'uploads after a %s discovery failure and retries discovery next time',
    async (kind) => {
      let discoveries = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (input !== capabilitiesUrl) return uploaded();
        discoveries += 1;
        if (discoveries > 1) return Response.json({ materials: { maxDocumentBytes: 4 } });
        if (kind === 'network') throw new TypeError('offline');
        if (kind === 'http') return new Response(null, { status: 503 });
        return new Response('invalid json');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(client.uploadWorkbenchMaterial(file())).resolves.toMatchObject({
        materialId: 'mat_test',
      });
      await expect(client.uploadWorkbenchMaterial(file())).rejects.toMatchObject({
        status: 413,
        maxBytes: 4,
      });
      expect(discoveries).toBe(2);
      expect(fetchMock.mock.calls.filter(([input]) => input === uploadUrl)).toHaveLength(1);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { maxMediaBytes: 1 },
    { maxDocumentBytes: 0 },
    { maxDocumentBytes: -1 },
    { maxDocumentBytes: '4' },
  ])('uploads when its cap is missing or invalid: %j', async (materials) => {
    const fetchMock = stubPolicy(materials);
    await expect(client.uploadWorkbenchMaterial(file())).resolves.toMatchObject({
      materialId: 'mat_test',
    });
    expect(fetchMock).toHaveBeenCalledWith(uploadUrl, expect.anything());
  });

  it('shares the pending discovery and caches it for later uploads', async () => {
    let resolve!: (response: Response) => void;
    const discovery = new Promise<Response>((answer) => {
      resolve = answer;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      input === capabilitiesUrl ? discovery : Promise.resolve(uploaded()),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = client.uploadWorkbenchMaterial(file());
    const second = client.uploadWorkbenchMaterial(file());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json({ materials: { maxDocumentBytes: 10, maxMediaBytes: 20 } }));
    await Promise.all([first, second]);
    await client.uploadWorkbenchMaterial(file());
    expect(fetchMock.mock.calls.filter(([input]) => input === capabilitiesUrl)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => input === uploadUrl)).toHaveLength(3);
  });

  it('uploads without a cap when discovery is slow, and uses the late answer afterwards', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (response: Response) => void;
      const discovery = new Promise<Response>((answer) => {
        resolve = answer;
      });
      const fetchMock = vi.fn((input: RequestInfo | URL) =>
        input === capabilitiesUrl ? discovery : Promise.resolve(uploaded()),
      );
      vi.stubGlobal('fetch', fetchMock);

      const first = client.uploadWorkbenchMaterial(file());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toMatchObject({ materialId: 'mat_test' });

      // Still unanswered: a later upload does not wait another five seconds.
      await expect(client.uploadWorkbenchMaterial(file())).resolves.toMatchObject({
        materialId: 'mat_test',
      });

      resolve(Response.json({ materials: { maxDocumentBytes: 4, maxMediaBytes: 4 } }));
      // Let the late answer settle before the next upload reads it.
      await vi.advanceTimersByTimeAsync(0);
      await expect(client.uploadWorkbenchMaterial(file())).rejects.toMatchObject({
        status: 413,
        maxBytes: 4,
      });
      expect(fetchMock.mock.calls.filter(([input]) => input === capabilitiesUrl)).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([input]) => input === uploadUrl)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a precheck 413 through the composer retry wrapper', async () => {
    const fetchMock = stubPolicy({ maxDocumentBytes: 4 });
    const upload = vi.fn(() => client.uploadWorkbenchMaterial(file()));
    const sleep = vi.fn(async () => undefined);
    await expect(retryMaterialUpload(upload, sleep)).rejects.toMatchObject({
      status: 413,
      maxBytes: 4,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
