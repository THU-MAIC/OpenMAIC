'use client';

/**
 * The "Model Services" section: one tab per capability, each with the list of
 * its services and the selected one's panel. The list and the panels read the
 * workspace's model configuration on the server; keys are written there and
 * never come back, and services the server configures are shown read-only.
 */
import { useMemo, useState } from 'react';
import {
  Box,
  FileText,
  Film,
  Image as ImageIcon,
  Mic,
  MoreHorizontal,
  Search,
  Trash2,
  Volume2,
  type LucideIcon,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import type { SlotCapability } from '@/lib/config/model-slots';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ApplyChange, ModelSettingsView } from '@/lib/model-settings/client';
import { serviceEntries, type ServiceEntry } from '@/lib/model-settings/services';
import { cn } from '@/lib/utils';
import type { SettingsSection } from '@/lib/types/settings';

import { AddProviderDialog } from './add-provider-dialog';
import { ASRSettings } from './asr-settings';
import { ImageSettings } from './image-settings';
import { PDFSettings } from './pdf-settings';
import { ProviderConfigPanel } from './provider-config-panel';
import { PINNED_PROVIDER_ID } from './provider-links';
import { ProviderList } from './provider-list';
import { removeServiceProvider, rootUse } from './server-settings';
import { REGISTRY_INFO, entryIcon, entryName, isEntryConfigured } from './service-display';
import { TTSSettings } from './tts-settings';
import { VideoSettings } from './video-settings';
import { WebSearchSettings } from './web-search-settings';

/** 「模型服务」分区内的服务 tab：沿用旧一级分区的值与面板组件。 */
export type ServiceTab = Extract<
  SettingsSection,
  'providers' | 'image' | 'video' | 'tts' | 'asr' | 'pdf' | 'web-search'
>;

export const SERVICE_TABS = [
  'providers',
  'image',
  'video',
  'tts',
  'asr',
  'pdf',
  'web-search',
] as const satisfies readonly ServiceTab[];

export const SERVICE_TAB_LABELS: Record<ServiceTab, string> = {
  providers: 'settings.providers',
  image: 'settings.imageSettings',
  video: 'settings.videoSettings',
  tts: 'settings.ttsSettings',
  asr: 'settings.asrSettings',
  pdf: 'settings.documentParsingSettings',
  'web-search': 'settings.webSearchSettings',
};

const SERVICE_TAB_ICONS: Record<ServiceTab, LucideIcon> = {
  providers: Box,
  image: ImageIcon,
  video: Film,
  tts: Volume2,
  asr: Mic,
  pdf: FileText,
  'web-search': Search,
};

export const SERVICE_TAB_DESCRIPTIONS: Record<ServiceTab, string> = {
  providers: 'settings.modelServices.desc.providers',
  image: 'settings.modelServices.desc.image',
  video: 'settings.modelServices.desc.video',
  tts: 'settings.modelServices.desc.tts',
  asr: 'settings.modelServices.desc.asr',
  pdf: 'settings.modelServices.desc.pdf',
  'web-search': 'settings.modelServices.desc.webSearch',
};

/** The capability (and root slot) each tab configures. */
export const TAB_CAPABILITY: Record<ServiceTab, SlotCapability> = {
  providers: 'chat',
  image: 'image',
  video: 'video',
  tts: 'tts',
  asr: 'asr',
  pdf: 'document',
  'web-search': 'webSearch',
};

export { REGISTRY_INFO, entryIcon, entryName, isEntryConfigured } from './service-display';

export function ModelServicesPanel({
  view,
  apply,
  tab,
  onTabChange,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
  tab: ServiceTab;
  onTabChange: (tab: ServiceTab) => void;
}) {
  const { t } = useI18n();
  const capability = TAB_CAPABILITY[tab];
  const entries = useMemo(() => {
    const list = serviceEntries(view, capability, REGISTRY_INFO[capability].ids);
    // Kimi 推广位：置顶于内置服务之首（其他账号/自定义服务在前，其余保持原顺序）。
    const rank = (entry: ServiceEntry) =>
      entry.provider && !entry.serviceId ? 0 : entry.id === PINNED_PROVIDER_ID ? 1 : 2;
    return capability === 'chat' ? [...list].sort((a, b) => rank(a) - rank(b)) : list;
  }, [view, capability]);
  const [selected, setSelected] = useState<Partial<Record<ServiceTab, string>>>({});
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [deleting, setDeleting] = useState<ServiceEntry | null>(null);

  const entry = entries.find((item) => item.id === selected[tab]) ?? entries[0];
  const select = (id: string) => setSelected((prev) => ({ ...prev, [tab]: id }));
  const canAdd = view.policy.allowWorkspaceProviders && view.presets.length > 0;

  const header = () => {
    if (!entry) return null;
    const name = entryName(entry, capability, t);
    const icon = entryIcon(entry, capability);
    const configured = isEntryConfigured(entry, capability);
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10">
            {icon ? (
              <img
                src={icon}
                alt={name}
                className={cn(
                  'size-5 object-contain',
                  MONO_LOGO_PROVIDERS.has(entry.serviceId ?? entry.registryId) && 'dark:invert',
                )}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="size-5 text-primary" />
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-[11px] text-muted-foreground">
              {configured
                ? t('settings.modelServices.configuredHint')
                : t('settings.modelServices.notConfiguredHint')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {entry.state === 'workspace' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('settings.more')}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleting(entry)}
                >
                  <Trash2 className="size-4" />
                  {t('settings.deleteProvider')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {entry.provider && rootUse(view, capability, entry.id).inUse && (
            <Badge variant="outline" className="shrink-0 text-primary">
              {t('settings.serverConfig.inUse')}
            </Badge>
          )}
          {configured ? (
            <Badge variant="secondary" className="shrink-0 text-emerald-600 dark:text-emerald-400">
              {t('settings.modelServices.ready')}
            </Badge>
          ) : (
            <Badge variant="secondary" className="shrink-0 text-amber-600 dark:text-amber-400">
              {t('settings.modelServices.pending')}
            </Badge>
          )}
        </div>
      </div>
    );
  };

  const panelProps = entry ? { view, apply, entry } : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 七个服务的胶囊 tab（收拢后的一级列） */}
      <div className="flex gap-1 overflow-x-auto pb-3" role="tablist">
        {SERVICE_TABS.map((id) => {
          const Icon = SERVICE_TAB_ICONS[id];
          const active = tab === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors',
                active
                  ? 'bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="size-3.5" />
              {t(SERVICE_TAB_LABELS[id])}
            </button>
          );
        })}
      </div>

      {/* provider 列表 + 配置面板（统一容器，对齐原型） */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border/50 max-sm:flex-col">
        <div className="w-52 shrink-0 border-r border-border/50 bg-muted/20 p-2 max-sm:max-h-48 max-sm:w-full max-sm:border-b max-sm:border-r-0">
          <ProviderList
            providers={entries.map((item) => ({
              id: item.id,
              name: entryName(item, capability, t),
              icon: entryIcon(item, capability),
              registryId: item.serviceId ?? item.registryId,
              configured: isEntryConfigured(item, capability),
            }))}
            selectedProviderId={entry?.id ?? ''}
            onSelect={select}
            onAddProvider={
              capability === 'chat' && canAdd ? () => setShowAddProvider(true) : undefined
            }
          />
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {header()}
          {panelProps && (
            <div className="mt-4" key={`${tab}:${entry!.id}`}>
              {tab === 'providers' && <ProviderConfigPanel {...panelProps} />}
              {tab === 'image' && <ImageSettings {...panelProps} />}
              {tab === 'video' && <VideoSettings {...panelProps} />}
              {tab === 'tts' && <TTSSettings {...panelProps} />}
              {tab === 'asr' && <ASRSettings {...panelProps} />}
              {tab === 'pdf' && <PDFSettings {...panelProps} />}
              {tab === 'web-search' && <WebSearchSettings {...panelProps} />}
            </div>
          )}
        </div>
      </div>

      <AddProviderDialog
        open={showAddProvider}
        onOpenChange={setShowAddProvider}
        view={view}
        apply={apply}
        onAdded={(id) => {
          setShowAddProvider(false);
          select(id);
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteProviderConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting?.provider) void removeServiceProvider(view, apply, deleting.id, t);
                setDeleting(null);
              }}
            >
              {t('settings.deleteProvider')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
