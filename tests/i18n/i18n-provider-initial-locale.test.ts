import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from '@/lib/hooks/use-i18n';
import i18n from '@/lib/i18n/config';
import { defaultLocale } from '@/lib/i18n/types';

function Greeting() {
  const { t } = useI18n();
  return createElement('span', null, t('home.greetingWithName', { name: 'classmate' }));
}

async function renderGreeting(locale: 'en-US' | 'zh-CN') {
  await i18n.changeLanguage(locale);
  const resources = i18n.getResourceBundle(locale, 'translation') as Record<string, unknown>;
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: locale,
      initialResources: resources,
      children: createElement(Greeting),
    }),
  );
}

describe('I18nProvider initial locale', () => {
  afterEach(async () => {
    await i18n.changeLanguage(defaultLocale);
  });

  it('renders the server-chosen English locale (no client re-detect)', async () => {
    const html = await renderGreeting('en-US');
    expect(html).toContain('Hi, classmate');
    expect(html).not.toContain('嗨');
  });

  it('keeps defaultLocale Chinese when that is the server choice', async () => {
    const html = await renderGreeting('zh-CN');
    expect(html).toContain('嗨，classmate');
    expect(html).not.toContain('Hi, classmate');
  });
});
