'use client';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  CLAUDE_WEB_SEARCH_DEFAULT_MODEL,
  CLAUDE_WEB_SEARCH_MODELS,
  WEB_SEARCH_PROVIDERS,
} from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { modelChange, modelRef } from '@/lib/model-settings/edit';
import {
  ApiKeyField,
  EndpointServerOnlyHint,
  ServerConfiguredNotice,
  ServerOnlyNotice,
  reportApply,
  rootUse,
  saveServiceProvider,
  type ServicePanelProps,
} from './server-settings';

/**
 * A web search service: its key (write-only) and, for Claude, the model that
 * searches, which is the workspace's search model while Claude is in use.
 */
export function WebSearchSettings({ view, apply, entry }: ServicePanelProps) {
  const { t } = useI18n();
  const provider = WEB_SEARCH_PROVIDERS[entry.registryId as WebSearchProviderId];
  const editable = entry.state === 'workspace' || entry.state === 'available';
  const use = rootUse(view, 'webSearch', entry.id);

  const buildRequestUrl = (baseUrl: string) => {
    const trimmed = baseUrl.replace(/\/$/, '');
    if (!provider?.endpointPath) return trimmed;
    if (trimmed.endsWith(provider.endpointPath)) return trimmed;
    return `${trimmed}${provider.endpointPath}`;
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {entry.state === 'deployment' && <ServerConfiguredNotice />}
      {entry.state === 'server-only' &&
        (entry.registryId === 'searxng' && view.policy.allowWorkspaceProviders ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300">
            {t('settings.searxngServerOnlyNotice')}
          </div>
        ) : (
          <ServerOnlyNotice policy={!view.policy.allowWorkspaceProviders} />
        ))}

      {editable && provider && !provider.requiresApiKey && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300">
          {t('settings.webSearchApiKeyOptional')}
        </div>
      )}

      {/* API Key + Base URL */}
      {editable && provider && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.webSearchApiKey')}</Label>
            <ApiKeyField
              name={`web-search-api-key-${entry.id}`}
              provider={entry.provider}
              placeholder={
                !provider.requiresApiKey
                  ? t('settings.optionalOverride')
                  : t('settings.enterApiKey')
              }
              inputClassName="font-mono text-sm"
              onSave={(apiKey) => saveServiceProvider(view, apply, entry, { apiKey }, t)}
              onRemove={() => saveServiceProvider(view, apply, entry, { apiKey: '' }, t)}
            />
            <p className="text-xs text-muted-foreground">{t('settings.webSearchApiKeyHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">{t('settings.webSearchBaseUrl')}</Label>
            {provider.defaultBaseUrl && (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {buildRequestUrl(provider.defaultBaseUrl)}
              </p>
            )}
            <EndpointServerOnlyHint />
          </div>
        </div>
      )}

      {/* Claude search model: the workspace's search model while Claude searches. */}
      {entry.registryId === 'claude' && entry.state !== 'server-only' && (
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.claudeSearchModel')}</Label>
          <Select
            value={use.modelId || CLAUDE_WEB_SEARCH_DEFAULT_MODEL}
            disabled={!use.inUse || !use.slot || use.slot.locked}
            onValueChange={async (value) => {
              if (!use.slot) return;
              reportApply(await apply(modelChange(use.slot, modelRef(entry.id, value)), view), t);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLAUDE_WEB_SEARCH_MODELS.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {use.inUse
              ? t('settings.claudeSearchModelHint')
              : t('settings.serverConfig.modelWhenInUse')}
          </p>
        </div>
      )}
    </div>
  );
}
