import type { ReactNode } from 'react';
import { rtlLocales } from '@/lib/i18n';
import { DocsRootProvider } from '@/components/docs-root-provider';

/**
 * Shared <html> shell for every root layout (default-locale tree and the
 * prefixed [lang] tree). Each route group has its own root layout so that the
 * default locale (en) can live at unprefixed URLs while other locales keep a
 * /<lang> prefix — this is what makes the static export hydrate cleanly.
 */
export function RootShell({
  lang,
  children,
}: {
  lang: string;
  children: ReactNode;
}) {
  const dir = rtlLocales.has(lang) ? 'rtl' : 'ltr';

  return (
    <html lang={lang} dir={dir} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen" suppressHydrationWarning>
        <DocsRootProvider lang={lang} dir={dir}>
          {children}
        </DocsRootProvider>
      </body>
    </html>
  );
}
