// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerMaterials } from '@/components/workbench/compose-extras';

const LOCALE_STORAGE_KEY = 'locale';

const values = new Map<string, string>();
const localStorageStub = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key: string) => values.get(key) ?? null,
  key: (index: number) => [...values.keys()][index] ?? null,
  removeItem: (key: string) => void values.delete(key),
  setItem: (key: string, value: string) => void values.set(key, String(value)),
} as Storage;

const LIMIT_TOAST = {
  'en-US': 'File too large. Please select a file no larger than 95.3 MB.',
  'zh-CN': '文件过大，请选择不超过 95.3MB 的文件。',
  'de-DE': 'Die Datei ist zu groß. Wähle eine Datei mit höchstens 95,3 MB aus.',
} as const;

const GENERIC_TOAST = '文件过大，请压缩或拆分后重试。';

function tooLargeResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'upload exceeds 100000000 bytes',
      maxBytes: 100_000_000,
    }),
    {
      status: 413,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'upload-trace-123',
      },
    },
  );
}

function pdfFile(): File {
  return new File(['stub'], 'notes.pdf', { type: 'application/pdf' });
}

async function loadModules() {
  vi.resetModules();
  const react = await import('react');
  const { createRoot } = await import('react-dom/client');
  const sonner = await import('sonner');
  const i18next = (await import('i18next')).default;
  const { I18nextProvider, initReactI18next } = await import('react-i18next');
  const { I18nProvider } = await import('@/lib/hooks/use-i18n');
  const { useComposerMaterials } = await import('@/components/workbench/compose-extras');
  const { workbenchResourceFor } = await import('@/lib/i18n/workbench');
  return {
    react,
    createRoot,
    sonner,
    i18next,
    I18nextProvider,
    initReactI18next,
    I18nProvider,
    useComposerMaterials,
    workbenchResourceFor,
  };
}

async function mountComposer(locale: string, fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('localStorage', localStorageStub);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorageStub.setItem(LOCALE_STORAGE_KEY, locale);

  const modules = await loadModules();
  const errorSpy = vi.spyOn(modules.sonner.toast, 'error').mockReturnValue('toast-id');
  const instance = modules.i18next.createInstance();
  await instance.use(modules.initReactI18next).init({
    lng: locale,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      [locale]: { translation: { workbench: modules.workbenchResourceFor(locale) } },
    },
  });

  const sink: { current: ComposerMaterials | null } = { current: null };
  function Harness() {
    sink.current = modules.useComposerMaterials();
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = modules.createRoot(container);
  await modules.react.act(async () => {
    root.render(
      modules.react.createElement(
        modules.I18nextProvider,
        { i18n: instance },
        modules.react.createElement(
          modules.I18nProvider,
          null,
          modules.react.createElement(Harness),
        ),
      ),
    );
  });

  return {
    sink,
    errorSpy,
    act: modules.react.act,
    async dispose() {
      await modules.react.act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('composer material upload toasts', () => {
  let dispose: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await dispose?.();
    dispose = null;
    localStorageStub.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['de-DE', 'zh-CN', 'en-US'] as const)(
    'shows the localized effective limit in toast after a 413 upload (%s)',
    async (locale) => {
      let materialPosts = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/agent/runtime')) return Response.json({ enabled: true });
        if (url.includes('/api/materials')) {
          materialPosts += 1;
          return tooLargeResponse();
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      const mounted = await mountComposer(locale, fetchMock);
      dispose = mounted.dispose;

      await mounted.act(async () => {
        await vi.waitFor(() => {
          expect(mounted.sink.current?.enabled).toBe(true);
        });
      });

      await mounted.act(async () => {
        mounted.sink.current?.addFiles([pdfFile()]);
        await vi.waitFor(() => {
          expect(mounted.errorSpy).toHaveBeenCalledTimes(1);
          expect(mounted.errorSpy).toHaveBeenCalledWith(LIMIT_TOAST[locale]);
        });
      });

      expect(mounted.errorSpy).toHaveBeenCalledTimes(1);
      expect(mounted.sink.current?.failed).toEqual([
        expect.objectContaining({ name: 'notes.pdf' }),
      ]);
      expect(mounted.sink.current?.materials).toEqual([]);
      expect(mounted.sink.current?.uploading).toEqual([]);
      expect(mounted.sink.current?.busy).toBe(false);
      expect(materialPosts).toBe(1);
    },
  );

  it.each([
    ['json', () => Response.json({ error: 'upload too large' }, { status: 413 })],
    [
      'html',
      () =>
        new Response('<html>Request Entity Too Large</html>', {
          status: 413,
          headers: { 'content-type': 'text/html' },
        }),
    ],
  ] as const)('shows the generic localized toast for a 413 %s body', async (_kind, respond) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/agent/runtime')) return Response.json({ enabled: true });
      if (url.includes('/api/materials')) return respond();
      throw new Error(`unexpected fetch ${url}`);
    });
    const mounted = await mountComposer('zh-CN', fetchMock);
    dispose = mounted.dispose;

    await mounted.act(async () => {
      await vi.waitFor(() => {
        expect(mounted.sink.current?.enabled).toBe(true);
      });
    });
    await mounted.act(async () => {
      mounted.sink.current?.addFiles([pdfFile()]);
      await vi.waitFor(() => {
        expect(mounted.errorSpy).toHaveBeenCalledTimes(1);
      });
    });

    expect(mounted.errorSpy).toHaveBeenCalledTimes(1);
    expect(mounted.errorSpy).toHaveBeenCalledWith(GENERIC_TOAST);
    expect(mounted.sink.current?.busy).toBe(false);
    expect(mounted.sink.current?.failed).toHaveLength(1);
    const shown = String(mounted.errorSpy.mock.calls[0]?.[0]);
    expect(shown).not.toContain('upload too large');
    expect(shown).not.toContain('Request Entity');
    expect(shown).not.toContain('requestId');
  });

  it('does not upload before the runtime probe enables materials', async () => {
    let materialPosts = 0;
    let resolveRuntime: (response: Response) => void = () => undefined;
    const runtime = new Promise<Response>((resolve) => {
      resolveRuntime = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/agent/runtime')) return runtime;
      if (url.includes('/api/materials')) {
        materialPosts += 1;
        return tooLargeResponse();
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mounted = await mountComposer('en-US', fetchMock);
    dispose = mounted.dispose;

    await mounted.act(async () => {
      mounted.sink.current?.addFiles([pdfFile()]);
    });

    expect(mounted.sink.current?.enabled).toBe(false);
    expect(materialPosts).toBe(0);
    expect(mounted.errorSpy).not.toHaveBeenCalled();
    resolveRuntime(Response.json({ enabled: false }));
    await runtime;
  });
});
