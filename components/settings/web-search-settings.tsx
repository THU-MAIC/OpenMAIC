'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { WEB_SEARCH_PROVIDERS, BAIDU_SUB_SOURCES } from '@/lib/web-search/constants';
import type { WebSearchProviderId, BaiduSubSources } from '@/lib/web-search/types';

interface WebSearchSettingsProps {
  selectedProviderId: WebSearchProviderId;
}

export function WebSearchSettings({ selectedProviderId }: WebSearchSettingsProps) {
  const { t, locale } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);

  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);
  const baiduSubSources = useSettingsStore((state) => state.baiduSubSources);
  const setBaiduSubSources = useSettingsStore((state) => state.setBaiduSubSources);

  const provider = WEB_SEARCH_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!webSearchProvidersConfig[selectedProviderId]?.isServerConfigured;
  const showApiKeyInput = provider.requiresApiKey || isServerConfigured;

  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
  }

  const effectiveBaseUrl =
    webSearchProvidersConfig[selectedProviderId]?.baseUrl || provider.defaultBaseUrl || '';

  return (
    <div className="space-y-6 max-w-3xl">
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {!provider.requiresApiKey && !isServerConfigured && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
          {t('settings.webSearchNoApiKeyNeeded')}
        </div>
      )}

      <div className={`grid gap-4 ${showApiKeyInput ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {showApiKeyInput && (
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
        )}

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

      {effectiveBaseUrl && (
        <p className="text-xs text-muted-foreground break-all">
          {t('settings.requestUrl')}: {effectiveBaseUrl}/search
        </p>
      )}

      {selectedProviderId === 'baidu' && (
        <div className="space-y-3">
          <Label className="text-sm font-medium">
            {locale === 'zh-CN' ? '搜索源' : 'Search Sources'}
          </Label>
          <div className="space-y-2">
            {(
              Object.entries(BAIDU_SUB_SOURCES) as [
                keyof BaiduSubSources,
                (typeof BAIDU_SUB_SOURCES)[keyof typeof BAIDU_SUB_SOURCES],
              ][]
            ).map(([key, meta]) => {
              const enabled = baiduSubSources?.[key] ?? true;
              return (
                <div key={key} className="flex items-center gap-2.5">
                  <span
                    className={`flex-1 text-sm font-medium transition-colors ${
                      !enabled ? 'text-muted-foreground' : ''
                    }`}
                  >
                    {meta.label[locale]}
                  </span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => setBaiduSubSources({ [key]: checked })}
                    className="scale-[0.85] origin-right"
                  />
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {locale === 'zh-CN'
              ? '选择百度搜索时使用的数据源，至少启用一个'
              : 'Choose which Baidu data sources to query. Enable at least one.'}
          </p>
        </div>
      )}
    </div>
  );
}
