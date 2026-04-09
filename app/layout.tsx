import type { Metadata } from 'next';
import { Nunito } from 'next/font/google';
import './globals.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { Analytics } from '@vercel/analytics/next';
import { cn } from '@/lib/utils';
import Script from 'next/script';

const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Slate',
  description:
    'AI-powered interactive classroom. Learn anything, with anyone, anytime.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn(nunito.variable, 'h-full')} suppressHydrationWarning>
      <body
        className={`font-sans antialiased h-full`}
        suppressHydrationWarning
      >
        <Script
          async
          src="https://www.googletagmanager.com/gtag/js?id=G-05Q10VRYSH"
        />
        <Script id="google-analytics">
          {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());

              gtag('config', 'G-05Q10VRYSH');
            `}
        </Script>
        <ThemeProvider>
          <I18nProvider>
            <ServerProvidersInit />
            {children}
            <Toaster position="top-center" />
          </I18nProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
