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
import { MONO_LOGO_PROVIDERS, PROVIDERS } from '@/lib/ai/providers';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { resolveASRProviderName, resolveTTSProviderName } from '@/lib/audio/provider-display';
import type { SlotCapability } from '@/lib/config/model-slots';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import { useI18n } from '@/lib/hooks/use-i18n';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { ApplyChange, ModelSettingsView } from '@/lib/model-settings/client';
import { entryConfigured, serviceEntries, type ServiceEntry } from '@/lib/model-settings/services';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS, getWebSearchProviderDisplayName } from '@/lib/web-search/constants';
import { cn } from '@/lib/utils';
import type { SettingsSection } from '@/lib/types/settings';

import { AddProviderDialog } from './add-provider-dialog';
import { ASRSettings } from './asr-settings';
import { ImageSettings } from './image-settings';
import { IMAGE_PROVIDER_NAMES, VIDEO_PROVIDER_NAMES } from './media-provider-names';
import { PDFSettings } from './pdf-settings';
import { ProviderConfigPanel } from './provider-config-panel';
import { PINNED_PROVIDER_ID } from './provider-links';
import { ProviderList } from './provider-list';
import { removeServiceProvider, rootUse, type T } from './server-settings';
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

const IMAGE_PROVIDER_ICONS: Record<string, string> = {
  seedream: '/logos/doubao.svg',
  'openai-image': '/logos/openai.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
  'minimax-image': '/logos/minimax.svg',
  'grok-image': '/logos/grok.svg',
  'comfyui-image': '/logos/comfyui.svg',
  'openrouter-image': '/logos/openrouter.svg',
  lemonade: '/logos/lemonade.svg',
};

const VIDEO_PROVIDER_ICONS: Record<string, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  'minimax-video': '/logos/minimax.svg',
  'grok-video': '/logos/grok.svg',
  'openrouter-video': '/logos/openrouter.svg',
  happyhorse: '/logos/qwen.svg',
};

interface RegistryInfo {
  ids: readonly string[];
  name: (id: string, t: T) => string;
  icon: (id: string) => string | undefined;
  requiresApiKey: (id: string) => boolean;
}

type Entry = { name?: string; icon?: string; requiresApiKey?: boolean };
const entryOf = (registry: Record<string, Entry>, id: string): Entry | undefined => registry[id];
const translated = (t: T, key: string, fallback: string) => {
  const text = t(key);
  return text && text !== key ? text : fallback;
};

/** Each capability's built-in services: their names, logos and whether they need a key. */
export const REGISTRY_INFO: Record<SlotCapability, RegistryInfo> = {
  chat: {
    ids: Object.keys(PROVIDERS),
    name: (id, t) =>
      translated(t, `settings.providerNames.${id}`, entryOf(PROVIDERS, id)?.name ?? id),
    icon: (id) => entryOf(PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(PROVIDERS, id)?.requiresApiKey !== false,
  },
  image: {
    ids: Object.keys(IMAGE_PROVIDERS),
    name: (id, t) =>
      translated(
        t,
        `settings.${(IMAGE_PROVIDER_NAMES as Record<string, string>)[id]}`,
        entryOf(IMAGE_PROVIDERS, id)?.name ?? id,
      ),
    icon: (id) => IMAGE_PROVIDER_ICONS[id],
    requiresApiKey: (id) => entryOf(IMAGE_PROVIDERS, id)?.requiresApiKey !== false,
  },
  video: {
    ids: Object.keys(VIDEO_PROVIDERS),
    name: (id, t) =>
      translated(
        t,
        `settings.${(VIDEO_PROVIDER_NAMES as Record<string, string>)[id]}`,
        entryOf(VIDEO_PROVIDERS, id)?.name ?? id,
      ),
    icon: (id) => VIDEO_PROVIDER_ICONS[id],
    requiresApiKey: (id) => entryOf(VIDEO_PROVIDERS, id)?.requiresApiKey !== false,
  },
  tts: {
    ids: Object.keys(TTS_PROVIDERS),
    name: (id, t) => resolveTTSProviderName(id, t),
    icon: (id) => entryOf(TTS_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(TTS_PROVIDERS, id)?.requiresApiKey !== false,
  },
  asr: {
    ids: Object.keys(ASR_PROVIDERS),
    name: (id, t) => resolveASRProviderName(id, t),
    icon: (id) => entryOf(ASR_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(ASR_PROVIDERS, id)?.requiresApiKey !== false,
  },
  document: {
    ids: Object.keys(PDF_PROVIDERS),
    name: (id) => entryOf(PDF_PROVIDERS, id)?.name ?? id,
    icon: (id) => entryOf(PDF_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(PDF_PROVIDERS, id)?.requiresApiKey !== false,
  },
  webSearch: {
    ids: Object.keys(WEB_SEARCH_PROVIDERS),
    name: (id, t) => getWebSearchProviderDisplayName(id as never, t),
    icon: (id) => entryOf(WEB_SEARCH_PROVIDERS, id)?.icon,
    requiresApiKey: (id) => entryOf(WEB_SEARCH_PROVIDERS, id)?.requiresApiKey !== false,
  },
};

const PLAN_BY_PRESET = new Map(
  TOKEN_PLAN_PRESETS.map((plan) => [tokenPlanPresetId(plan.id), plan]),
);

/**
 * A service's name: a plan's own name; a built-in service's name for its
 * entry (a provider named after it included); else the provider's preset and
 * id ("OpenAI-compatible · gateway"), so two accounts of one service stay apart.
 */
export function entryName(entry: ServiceEntry, capability: SlotCapability, t: T): string {
  const provider = entry.provider;
  const plan = provider ? PLAN_BY_PRESET.get(provider.preset) : undefined;
  if (plan) return plan.id === 'volcengine-ark' ? 'Seed' : plan.name;
  if (!provider || entry.serviceId) {
    return REGISTRY_INFO[capability].name(entry.serviceId ?? entry.registryId, t);
  }
  const presetName =
    provider.preset === 'openai-compatible'
      ? t('settings.serverConfig.openaiCompatible')
      : REGISTRY_INFO[capability].name(entry.registryId, t);
  return `${presetName} · ${provider.id}`;
}

/** A service's logo: its plan's or built-in service's; none (a generic box) for a custom endpoint. */
export function entryIcon(entry: ServiceEntry, capability: SlotCapability): string | undefined {
  const plan = entry.provider ? PLAN_BY_PRESET.get(entry.provider.preset) : undefined;
  if (plan) return plan.icon;
  if (entry.serviceId) return REGISTRY_INFO[capability].icon(entry.serviceId);
  if (entry.provider?.preset === 'openai-compatible') return undefined;
  return REGISTRY_INFO[capability].icon(entry.registryId);
}

export function isEntryConfigured(entry: ServiceEntry, capability: SlotCapability): boolean {
  return entryConfigured(entry, REGISTRY_INFO[capability].requiresApiKey(entry.registryId));
}

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
