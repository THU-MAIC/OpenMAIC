import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '@/lib/hooks/use-i18n';
import i18n from '@/lib/i18n/config';
import { NarrationWarning } from '@/components/classroom/NarrationWarning';

async function render(count: number, language: string) {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(NarrationWarning, { count })),
  );
}

describe('generation narration warning', () => {
  it('has no warning when no clips were skipped', async () => {
    expect(await render(0, 'en-US')).toBe('');
  });

  it.each(['en-US', 'zh-CN'])('shows the count and recovery guidance in %s', async (locale) => {
    const markup = await render(3, locale);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('3');
    expect(markup).not.toContain('{{');
    expect(markup).not.toContain('generation.narrationWarning');
    expect(markup).toContain(locale === 'zh-CN' ? '存储' : 'storage');
    expect(markup).toContain(locale === 'zh-CN' ? '时间轴' : 'timeline');
  });
});
