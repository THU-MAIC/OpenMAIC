// @vitest-environment jsdom
import { act, createElement, useEffect, type ComponentProps, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import { I18nProvider, useI18n } from '@/lib/hooks/use-i18n';
import type { Locale } from '@/lib/i18n';

// Hold chosen locales' resource loads open, so a switch to a language that has
// not been loaded yet goes through the asynchronous path; fail others outright.
const gates = vi.hoisted(() => new Map<string, Promise<void>>());
const failing = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/i18n/load-resource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/i18n/load-resource')>();
  return {
    ...actual,
    loadLocaleResource: async (language: string) => {
      await gates.get(language);
      if (failing.has(language)) throw new Error(`no ${language} bundle`);
      return actual.loadLocaleResource(language);
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Node 25+ ships its own `localStorage` global, which shadows jsdom's.
const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  clear: () => stored.clear(),
});

function gate(language: string): () => void {
  let release!: () => void;
  gates.set(language, new Promise<void>((resolve) => (release = resolve)));
  return release;
}

let switchTo: (locale: Locale) => void = () => {};

function Greeting() {
  const { t, locale, setLocale } = useI18n();
  useEffect(() => {
    switchTo = setLocale;
  });
  return createElement(
    'span',
    { 'data-locale': locale },
    t('home.greetingWithName', { name: 'Ada' }),
  );
}

function app(props: {
  initialLocale: Locale;
  initialResources: Record<string, unknown>;
}): ReactNode {
  return createElement(
    I18nProvider,
    props as ComponentProps<typeof I18nProvider>,
    createElement(Greeting),
  );
}

const enApp = () => app({ initialLocale: 'en-US', initialResources: enUS });

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  document.documentElement.lang = 'en-US';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  gates.clear();
  failing.clear();
  document.cookie = 'locale=; Max-Age=0; Path=/';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function waitFor(check: () => void) {
  for (let i = 0; i < 100; i++) {
    try {
      return check();
    } catch {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
  check();
}

describe('I18nProvider initial locale', () => {
  it('hydrates the server-chosen locale without re-detecting from the browser', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja-JP');
    localStorage.setItem('locale', 'en-US');

    const html = renderToString(enApp());
    expect(html).toContain('Hi, Ada');

    container.innerHTML = html;
    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error');
    await act(async () => {
      root = hydrateRoot(container, enApp(), {
        onRecoverableError: (error) => recoverable.push(error),
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Hi, Ada');
    // The stored choice matched, so it now lives in the cookie as well.
    expect(document.cookie).toContain('locale=en-US');
  });

  it('applies a language saved only in localStorage by an earlier version', async () => {
    document.cookie = 'locale=garbage; Path=/';
    localStorage.setItem('locale', 'zh-CN');
    await act(async () => {
      root = createRoot(container);
      root.render(enApp());
    });
    await waitFor(() => expect(container.textContent).toBe('嗨，Ada'));
    expect(document.cookie).toContain('locale=zh-CN');
  });

  it('lets a valid locale cookie win over a different localStorage value', async () => {
    document.cookie = 'locale=en-US; Path=/';
    localStorage.setItem('locale', 'ko-KR');
    await act(async () => {
      root = createRoot(container);
      root.render(enApp());
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.querySelector('span')?.dataset.locale).toBe('en-US');
    expect(document.cookie).toBe('locale=en-US');
  });
});

describe('I18nProvider setLocale', () => {
  it('stays on the current locale when the new bundle fails to load, and can retry', async () => {
    failing.add('ru-RU');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      root = createRoot(container);
      root.render(enApp());
    });

    act(() => switchTo('ru-RU'));
    await waitFor(() => expect(document.cookie).toContain('locale=en-US'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.querySelector('span')?.dataset.locale).toBe('en-US');
    expect(container.textContent).toBe('Hi, Ada');
    expect(document.documentElement.lang).toBe('en-US');
    expect(localStorage.getItem('locale')).toBe('en-US');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('ru-RU'), expect.any(Error));

    failing.clear();
    act(() => switchTo('ru-RU'));
    await waitFor(() => expect(container.querySelector('span')?.dataset.locale).toBe('ru-RU'));
    expect(document.documentElement.lang).toBe('ru-RU');
    expect(document.cookie).toContain('locale=ru-RU');
  });

  it('shows the new language once a cold resource load finishes', async () => {
    const release = gate('ja-JP');
    await act(async () => {
      root = createRoot(container);
      root.render(enApp());
    });
    expect(container.textContent).toBe('Hi, Ada');

    act(() => switchTo('ja-JP'));
    // The choice is persisted at once, so a reload during the load keeps it.
    expect(document.cookie).toContain('locale=ja-JP');
    expect(localStorage.getItem('locale')).toBe('ja-JP');

    await act(async () => release());
    await waitFor(() => expect(container.textContent).toBe('こんにちは、Adaさん'));
    expect(container.querySelector('span')?.dataset.locale).toBe('ja-JP');
    expect(document.documentElement.lang).toBe('ja-JP');
  });

  it('keeps the latest choice when an earlier switch finishes loading last', async () => {
    const releaseKo = gate('ko-KR');
    await act(async () => {
      root = createRoot(container);
      root.render(enApp());
    });

    act(() => switchTo('ko-KR'));
    act(() => switchTo('de-DE'));
    await waitFor(() => expect(container.querySelector('span')?.dataset.locale).toBe('de-DE'));

    await act(async () => releaseKo());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.querySelector('span')?.dataset.locale).toBe('de-DE');
    expect(container.textContent).not.toContain('Ada님');
    expect(document.documentElement.lang).toBe('de-DE');
    expect(document.cookie).toContain('locale=de-DE');
  });
});
