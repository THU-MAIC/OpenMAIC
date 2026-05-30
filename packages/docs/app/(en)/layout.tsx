import '../global.css';
import type { ReactNode } from 'react';
import { RootShell } from '@/components/root-shell';
import { i18n } from '@/lib/i18n';

// Root layout for the default locale (en), served at unprefixed URLs.
export default function Layout({ children }: { children: ReactNode }) {
  return <RootShell lang={i18n.defaultLanguage}>{children}</RootShell>;
}
