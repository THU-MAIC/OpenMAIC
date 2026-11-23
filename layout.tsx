import './globals.css';
import '@fontsource-variable/inter';
import '@openmaic/renderer/fonts.css';
import 'katex/dist/katex.min.css';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { AdaptiveProvider } from '@/lib/adaptive/adaptive-provider';
import { ThemeProvider } from '@/lib/hooks/use-theme';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={GeistSans.variable + ' ' + GeistMono.variable + ' antialiased'}>
        <AdaptiveProvider initialMobileLayout={false}>
          <ThemeProvider>{children}</ThemeProvider>
        </AdaptiveProvider>
      </body>
    </html>
  );
}
