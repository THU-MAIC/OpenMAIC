'use client';

import { useI18n } from '@/lib/hooks/use-i18n';

type I18nTextProps = {
  k: string;
  fallback?: string;
};

export function I18nText({ k, fallback }: I18nTextProps) {
  const { t } = useI18n();
  const value = t(k);
  return <>{value === k ? (fallback ?? k) : value}</>;
}
