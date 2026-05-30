import '../../global.css';
import type { ReactNode } from 'react';
import { RootShell } from '@/components/root-shell';

// Root layout for non-default locales, served at /<lang> prefixed URLs.
export default async function Layout({
  children,
  params,
}: LayoutProps<'/[lang]'>) {
  const { lang } = await params;
  return <RootShell lang={lang}>{children}</RootShell>;
}
