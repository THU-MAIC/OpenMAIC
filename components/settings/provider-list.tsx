'use client';

import { Box, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderId, ProviderConfig } from '@/lib/ai/providers';
import { MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';

interface ProviderWithServerInfo extends ProviderConfig {
  isServerConfigured?: boolean;
  apiKey?: string;
}

interface ProviderListProps {
  providers: ProviderWithServerInfo[];
  selectedProviderId: ProviderId;
  onSelect: (providerId: ProviderId) => void;
  onAddProvider: () => void;
}

// 「模型服务」分区内的语言模型服务列表：样式对齐原型
// model-services-panel（头像 + 名称 + 配置状态点，选中为描边卡片）。
export function ProviderList({
  providers,
  selectedProviderId,
  onSelect,
  onAddProvider,
}: ProviderListProps) {
  const { t } = useI18n();

  // Helper function to get translated provider name
  const getProviderDisplayName = (provider: ProviderConfig) => {
    const translationKey = `settings.providerNames.${provider.id}`;
    const translated = t(translationKey);
    // If translation exists (not equal to key), use it; otherwise fallback to provider.name
    return translated !== translationKey ? translated : provider.name;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto p-1">
        {providers.map((provider) => {
          const configured =
            !!provider.isServerConfigured || !!provider.apiKey || provider.requiresApiKey === false;
          const active = selectedProviderId === provider.id;
          return (
            <button
              key={provider.id}
              onClick={() => onSelect(provider.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                active ? 'bg-background shadow-sm ring-1 ring-border/70' : 'hover:bg-background/60',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors',
                  active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {provider.icon ? (
                  <img
                    src={provider.icon}
                    alt={getProviderDisplayName(provider)}
                    className={cn(
                      'size-4 object-contain',
                      MONO_LOGO_PROVIDERS.has(provider.id) && 'dark:invert',
                    )}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Box className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-xs leading-tight',
                    active ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {getProviderDisplayName(provider)}
                </span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span
                    className={cn(
                      'size-1 rounded-full',
                      configured ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                  />
                  {configured
                    ? t('settings.modelServices.configured')
                    : t('settings.modelServices.notConfigured')}
                </span>
              </span>
            </button>
          );
        })}

        {/* Add Provider（列表尾部的幽灵行） */}
        <button
          onClick={onAddProvider}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-background/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t('settings.addProviderButton')}
        </button>
      </div>
    </div>
  );
}
