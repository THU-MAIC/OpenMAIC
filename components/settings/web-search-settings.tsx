'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { Eye, EyeOff } from 'lucide-react';

interface WebSearchSettingsProps {
  selectedProviderId: WebSearchProviderId;
}

export function WebSearchSettings({ selectedProviderId }: WebSearchSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);

  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  const provider = WEB_SEARCH_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!webSearchProvidersConfig[selectedProviderId]?.isServerConfigured;

  // Reset showApiKey when provider changes (derived state pattern)
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key + Base URL Configuration */}
      {(provider.requiresApiKey || isServerConfigured) && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.webSearchApiKey')}</Label>
              <div className="relative">
                <Input
                  name={`web-search-api-key-${selectedProviderId}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
                  }
                  value={webSearchProvidersConfig[selectedProviderId]?.apiKey || ''}
                  onChange={(e) =>
                    setWebSearchProviderConfig(selectedProviderId, {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.webSearchApiKeyHint')}</p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">{t('settings.webSearchBaseUrl')}</Label>
              <Input
                name={`web-search-base-url-${selectedProviderId}`}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={provider.defaultBaseUrl || 'https://api.tavily.com'}
                value={webSearchProvidersConfig[selectedProviderId]?.baseUrl || ''}
                onChange={(e) =>
                  setWebSearchProviderConfig(selectedProviderId, {
                    baseUrl: e.target.value,
                  })
                }
                className="text-sm"
              />
            </div>
          </div>

          {/* Request URL Preview */}
          {(() => {
            const effectiveBaseUrl =
              webSearchProvidersConfig[selectedProviderId]?.baseUrl ||
              provider.defaultBaseUrl ||
              '';
            if (!effectiveBaseUrl) return null;
            const fullUrl = effectiveBaseUrl + '/search';
            return (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {fullUrl}
              </p>
            );
          })()}
        </>
      )}
    </div>
  );
}
