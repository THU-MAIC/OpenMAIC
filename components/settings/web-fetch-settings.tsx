'use client';

import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import providers from '@/lib/web-fetch/metadata.generated.json';
import {
  ApiKeyField,
  EndpointServerOnlyHint,
  ServerConfiguredNotice,
  ServerOnlyNotice,
  saveServiceProvider,
  type ServicePanelProps,
} from './server-settings';

export function WebFetchSettings({ view, apply, entry }: ServicePanelProps) {
  const { t } = useI18n();
  const provider = (providers as Record<string, { requiresApiKey: boolean }>)[entry.registryId];
  const editable = entry.state === 'workspace' || entry.state === 'available';
  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">{t('settings.webFetchHint')}</p>
      {entry.state === 'deployment' && <ServerConfiguredNotice view={view} capability="webFetch" />}
      {entry.state === 'server-only' && <ServerOnlyNotice noUserKeys={!view.allowUserKeys} />}
      {editable && provider?.requiresApiKey && (
        <div className="space-y-2">
          <Label>{t('settings.webFetchApiKey')}</Label>
          <ApiKeyField
            name={`web-fetch-api-key-${entry.id}`}
            provider={entry.provider}
            placeholder={t('settings.enterApiKey')}
            onSave={(apiKey) => saveServiceProvider(view, apply, entry, { apiKey }, t)}
            onRemove={() => saveServiceProvider(view, apply, entry, { apiKey: '' }, t)}
          />
          <EndpointServerOnlyHint />
        </div>
      )}
    </div>
  );
}
