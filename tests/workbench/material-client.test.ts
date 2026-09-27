import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkbenchSession,
  postWorkbenchMessage,
  uploadWorkbenchMaterial,
  WorkbenchMaterialUploadError,
} from '@/lib/workbench/session-store';
import { WORKBENCH_MATERIAL_ACCEPT } from '@/lib/workbench/material-upload-policy';
import {
  createWorkbenchTranslator,
  workbenchResourceFor,
  type WorkbenchTranslator,
} from '@/lib/i18n/workbench';

const material = {
  materialId: 'mat_00000000000000000000000000',
  name: '讲义.pdf',
  bytes: 5,
  mimeType: 'application/pdf',
  extractionStatus: 'idle' as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('resolves a generic browser MIME to the concrete type before upload', async () => {
    // Older Linux XDG mime databases report OOXML files as the generic
    // `application/vnd.ms-office` container (#1497); the request must carry
    // the concrete type or the server gate answers 415.
    const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        materialId: material.materialId,
        originalName: 'slides.pptx',
        bytes: 5,
        mime: pptxMime,
        extraction: { status: 'idle' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['hello'], 'slides.pptx', { type: 'application/vnd.ms-office' });
    await expect(uploadWorkbenchMaterial(file)).resolves.toMatchObject({ mimeType: pptxMime });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/materials',
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-type': pptxMime,
          'x-material-filename': encodeURIComponent('slides.pptx'),
        }),
      }),
    );
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

  it.each([415, 429] as const)(
    'keeps diagnostic details on a %s error while showing localized copy',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            { error: 'raw server failure' },
            { status, headers: { 'x-request-id': 'upload-trace-123' } },
          ),
        ),
      );
      const error = await uploadWorkbenchMaterial(new File(['x'], material.name)).catch(
        (err) => err,
      );
      expect(error).toBeInstanceOf(WorkbenchMaterialUploadError);
      expect(error).toMatchObject({
        status,
        requestId: 'upload-trace-123',
        message: 'raw server failure [requestId=upload-trace-123]',
      });
      expect(error.userMessage(createWorkbenchTranslator('zh-CN'), 'zh-CN')).toBe(
        status === 415 ? '不支持此文件类型，请选择受支持的文件。' : '已达到材料上传限额。',
      );
    },
  );

  it.each([50, 100, 12.5])(
    'shows the configured %s MB limit without diagnostic details',
    async (mb) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            { error: `upload exceeds ${mb * 1024 * 1024} bytes`, maxBytes: mb * 1024 * 1024 },
            { status: 413, headers: { 'x-request-id': 'upload-trace-123' } },
          ),
        ),
      );
      const error = await uploadWorkbenchMaterial(new File(['x'], material.name)).catch(
        (err) => err,
      );
      expect(error).toBeInstanceOf(WorkbenchMaterialUploadError);
      expect(error.requestId).toBe('upload-trace-123');
      expect(error.message).toContain('upload-trace-123');
      expect(error.userMessage(createWorkbenchTranslator('zh-CN'), 'zh-CN')).toBe(
        `文件过大，请选择不超过 ${mb}MB 的文件。`,
      );
      expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
        `File too large. Please select a file no larger than ${mb} MB.`,
      );
    },
  );

  it.each([undefined, 0, -1, '52428800'])(
    'uses a friendly fallback for invalid limit %s',
    async (maxBytes) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'upload too large', maxBytes }, { status: 413 })),
      );
      const error = await uploadWorkbenchMaterial(new File(['x'], material.name)).catch(
        (err) => err,
      );
      expect(error.maxBytes).toBeUndefined();
      expect(error.userMessage(createWorkbenchTranslator('zh-CN'), 'zh-CN')).toBe(
        '文件过大，请压缩或拆分后重试。',
      );
    },
  );

  it('handles a proxy HTML 413 without exposing its body or a request ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Request Entity Too Large</html>', { status: 413 })),
    );
    const error = await uploadWorkbenchMaterial(new File(['x'], material.name)).catch((err) => err);
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
      'File too large. Compress or split the file and try again.',
    );
  });

  it.each([
    ['en-US', 'File too large. Please select a file no larger than 95.3 MB.'],
    ['zh-CN', '文件过大，请选择不超过 95.3MB 的文件。'],
    ['de-DE', 'Die Datei ist zu groß. Wähle eine Datei mit höchstens 95,3 MB aus.'],
    ['fr-FR', 'Fichier trop volumineux. Sélectionnez un fichier de 95,3 Mo maximum.'],
    ['ar-SA', 'الملف كبير جدًا. اختر ملفًا لا يتجاوز حجمه 95.3 ميجابايت.'],
  ] as const)('rounds a non-MiB limit down for %s', (locale, expected) => {
    const error = new WorkbenchMaterialUploadError(
      'upload exceeds 100000000 bytes [requestId=upload-trace-123]',
      413,
      'upload-trace-123',
      100_000_000,
    );
    expect(error.maxBytes).toBe(100_000_000);
    expect(error.message).toContain('upload-trace-123');
    expect(error.userMessage(createWorkbenchTranslator(locale), locale)).toBe(expected);
    expect(error.userMessage(createWorkbenchTranslator(locale), locale)).not.toContain('95.4');
    expect(error.userMessage(createWorkbenchTranslator(locale), locale)).not.toContain('requestId');
  });

  it.each([1, 104_857])(
    'uses the generic message for a positive limit below 0.1 MiB (%s bytes)',
    (maxBytes) => {
      const error = new WorkbenchMaterialUploadError(
        'upload exceeds 1 bytes',
        413,
        undefined,
        maxBytes,
      );
      expect(error.maxBytes).toBe(maxBytes);
      expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
        'File too large. Compress or split the file and try again.',
      );
      expect(error.userMessage(createWorkbenchTranslator('zh-CN'), 'zh-CN')).toBe(
        '文件过大，请压缩或拆分后重试。',
      );
    },
  );

  it.each([
    ['en-US', 'File too large. Please select a file no larger than 0.1 MB.'],
    ['de-DE', 'Die Datei ist zu groß. Wähle eine Datei mit höchstens 0,1 MB aus.'],
  ] as const)(
    'shows 0.1 for the first integer-byte limit above 0.1 MiB in %s',
    (locale, expected) => {
      const error = new WorkbenchMaterialUploadError(
        'upload exceeds 104858 bytes',
        413,
        undefined,
        104_858,
      );
      expect(error.userMessage(createWorkbenchTranslator(locale), locale)).toBe(expected);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the generic message for non-finite limit %s without dropping it from the error',
    (maxBytes) => {
      const error = new WorkbenchMaterialUploadError('upload too large', 413, undefined, maxBytes);
      expect(error.maxBytes).toBe(maxBytes);
      expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
        'File too large. Compress or split the file and try again.',
      );
    },
  );

  it('uses the generic message when floor rounding is unavailable', () => {
    const RealNumberFormat = Intl.NumberFormat;
    let resolvedCalls = 0;
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function NumberFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      const rest = { ...options };
      delete rest.roundingMode;
      const formatter = new RealNumberFormat(locales, rest);
      const resolved = formatter.resolvedOptions();
      vi.spyOn(formatter, 'resolvedOptions').mockImplementation(() => {
        resolvedCalls += 1;
        return { ...resolved, roundingMode: 'halfExpand' };
      });
      return formatter;
    });
    const error = new WorkbenchMaterialUploadError(
      'upload exceeds 100000000 bytes',
      413,
      undefined,
      100_000_000,
    );
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
      'File too large. Compress or split the file and try again.',
    );
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).not.toContain('95.4');
    expect(resolvedCalls).toBe(2);
  });

  it('uses the generic message when the number formatter cannot be constructed', () => {
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function NumberFormat() {
      throw new TypeError('formatter unavailable');
    });
    const error = new WorkbenchMaterialUploadError(
      'upload exceeds 100000000 bytes',
      413,
      undefined,
      100_000_000,
    );
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
      'File too large. Compress or split the file and try again.',
    );
  });

  it('does not insert grouping separators into a four-digit limit', () => {
    const error = new WorkbenchMaterialUploadError(
      'upload exceeds 1073741824 bytes',
      413,
      undefined,
      1024 * 1024 * 1024,
    );
    expect(error.userMessage(createWorkbenchTranslator('en-US'), 'en-US')).toBe(
      'File too large. Please select a file no larger than 1024 MB.',
    );
    expect(error.userMessage(createWorkbenchTranslator('de-DE'), 'de-DE')).toBe(
      'Die Datei ist zu groß. Wähle eine Datei mit höchstens 1024 MB aus.',
    );
  });

  it('produces the same localized limit through i18next and the hook-free translator', async () => {
    const i18next = (await import('i18next')).default;
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'de-DE',
      fallbackLng: false,
      interpolation: { escapeValue: false },
      resources: {
        'de-DE': { translation: { workbench: workbenchResourceFor('de-DE') } },
      },
    });
    const expected = 'Die Datei ist zu groß. Wähle eine Datei mit höchstens 95,3 MB aus.';
    const error = new WorkbenchMaterialUploadError(
      'upload exceeds 100000000 bytes [requestId=upload-trace-123]',
      413,
      'upload-trace-123',
      100_000_000,
    );
    const i18nextTranslator: WorkbenchTranslator = (key, options) => instance.t(key, options);
    expect(error.userMessage(createWorkbenchTranslator('de-DE'), 'de-DE')).toBe(expected);
    expect(error.userMessage(i18nextTranslator, 'de-DE')).toBe(expected);
    expect(error.message).toContain('[requestId=upload-trace-123]');
  });

  it.each([400, 500])('preserves status %s messages unchanged', (status) => {
    const error = new WorkbenchMaterialUploadError('slow down', status);
    expect(error.userMessage(createWorkbenchTranslator('zh-CN'), 'zh-CN')).toBe('slow down');
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
