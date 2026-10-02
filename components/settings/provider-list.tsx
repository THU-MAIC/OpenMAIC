'use client';

import { Box, ExternalLink, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import { PINNED_PROVIDER_ID, PROVIDER_SIGNUP_LINKS, pickRegionalLink } from './provider-links';

export interface ProviderListItem {
  id: string;
  name: string;
  icon?: string;
  /** The registry entry, for the logo's dark-mode treatment and signup links. */
  registryId: string;
  configured: boolean;
}

interface ProviderListProps {
  providers: ProviderListItem[];
  selectedProviderId: string;
  onSelect: (providerId: string) => void;
  onAddProvider?: () => void;
}

// 「模型服务」分区内的服务列表：样式对齐原型
// model-services-panel（头像 + 名称 + 配置状态点，选中为描边卡片）。
export function ProviderList({
  providers,
  selectedProviderId,
  onSelect,
  onAddProvider,
}: ProviderListProps) {
  const { t, locale } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto p-1">
        {providers.map((provider) => {
          const configured = provider.configured;
          const active = selectedProviderId === provider.id;
          // 推广位（如 Kimi）：常驻主色描边强调（选中态沿用更深的选中描边），
          // 行尾附获取 API key 的跳转（按界面语言分流国内/海外）。
          const promoted = provider.id === PINNED_PROVIDER_ID;
          const signupLinks = configured ? undefined : PROVIDER_SIGNUP_LINKS[provider.id];
          return (
            // 外链必须是 button 的兄弟节点（交互元素不可嵌套）：绝对定位覆盖在
            // 行右端，点击不会透传到选择按钮；有链接的行给按钮留出右侧空间。
            <div key={provider.id} className="relative">
              <button
                onClick={() => onSelect(provider.id)}
                aria-pressed={active}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                  signupLinks && 'pr-8',
                  active
                    ? 'bg-background shadow-sm ring-1 ring-border/70'
                    : cn(
                        'hover:bg-background/60',
                        promoted && 'bg-primary/[0.04] ring-1 ring-primary/25',
                      ),
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
                      alt={provider.name}
                      className={cn(
                        'size-4 object-contain',
                        MONO_LOGO_PROVIDERS.has(provider.registryId) && 'dark:invert',
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
                    {provider.name}
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
              {signupLinks && (
                <a
                  href={pickRegionalLink(signupLinks, locale)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('settings.providerLinks.getApiKey')}
                  className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-sm p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          );
        })}

        {/* Add Provider（列表尾部的幽灵行） */}
        {onAddProvider && (
          <button
            onClick={onAddProvider}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-background/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t('settings.addProviderButton')}
          </button>
        )}
      </div>
    </div>
  );
}
