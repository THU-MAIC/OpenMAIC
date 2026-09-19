'use client';

import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export function ApiKeySecurityNotice() {
  const { t } = useI18n();

  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
      <span>{t('settings.apiKeySecurityNotice')}</span>
    </p>
  );
}
