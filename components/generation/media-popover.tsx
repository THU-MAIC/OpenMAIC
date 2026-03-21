'use client';

import { useState, useCallback, useMemo, useEffect, Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Image as ImageIcon,
  Video,
  Volume2,
  Mic,
  SlidersHorizontal,
  ChevronRight,
  Play,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { TTS_PROVIDERS, getTTSVoices } from '@/lib/audio/constants';
import { ASR_PROVIDERS, getASRSupportedLanguages } from '@/lib/audio/constants';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId, ASRProviderId } from '@/lib/audio/types';
import type { SettingsSection } from '@/lib/types/settings';

interface MediaPopoverProps {
  onSettingsOpen: (section: SettingsSection) => void;
}

// ─── Provider icon maps ───
const IMAGE_PROVIDER_ICONS: Record<string, string> = {
  seedream: '/logos/doubao.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
  'grok-image': '/logos/grok.svg',
};
const VIDEO_PROVIDER_ICONS: Record<string, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  sora: '/logos/openai.svg',
  'grok-video': '/logos/grok.svg',
};

type TabId = 'image' | 'video' | 'tts' | 'asr';

const LANG_LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  it: 'Italiano',
  ar: 'العربية',
  hi: 'हिन्दी',
};

const TABS: Array<{ id: TabId; icon: LucideIcon; label: string }> = [
  { id: 'image', icon: ImageIcon, label: 'Image' },
  { id: 'video', icon: Video, label: 'Video' },
  { id: 'tts', icon: Volume2, label: 'TTS' },
  { id: 'asr', icon: Mic, label: 'ASR' },
];

/** Localized TTS provider name (mirrors audio-settings.tsx) */
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  const names: Record<TTSProviderId, string> = {
    'openai-tts': t('settings.providerOpenAITTS'),
    'azure-tts': t('settings.providerAzureTTS'),
    'glm-tts': t('settings.providerGLMTTS'),
    'qwen-tts': t('settings.providerQwenTTS'),
    'browser-native-tts': t('settings.providerBrowserNativeTTS'),
  };
  return names[providerId] || providerId;
}

/** Extract the English name from voice name format "ChineseName (English)" */
function getVoiceDisplayName(name: string, lang: string): string {
  if (lang === 'en-US') {
    const match = name.match(/\(([^)]+)\)/);
    return match ? match[1] : name;
  }
  return name;
}

export function MediaPopover({ onSettingsOpen }: MediaPopoverProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('image');
  const { previewing, startPreview, stopPreview } = useTTSPreview();

  // ─── Store ───
  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const asrEnabled = useSettingsStore((s) => s.asrEnabled);
  const setImageGenerationEnabled = useSettingsStore((s) => s.setImageGenerationEnabled);
  const setVideoGenerationEnabled = useSettingsStore((s) => s.setVideoGenerationEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const setASREnabled = useSettingsStore((s) => s.setASREnabled);

  const imageProviderId = useSettingsStore((s) => s.imageProviderId);
  const imageModelId = useSettingsStore((s) => s.imageModelId);
  const imageProvidersConfig = useSettingsStore((s) => s.imageProvidersConfig);
  const setImageProvider = useSettingsStore((s) => s.setImageProvider);
  const setImageModelId = useSettingsStore((s) => s.setImageModelId);

  const videoProviderId = useSettingsStore((s) => s.videoProviderId);
  const videoModelId = useSettingsStore((s) => s.videoModelId);
  const videoProvidersConfig = useSettingsStore((s) => s.videoProvidersConfig);
  const setVideoProvider = useSettingsStore((s) => s.setVideoProvider);
  const setVideoModelId = useSettingsStore((s) => s.setVideoModelId);

  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSProvider = useSettingsStore((s) => s.setTTSProvider);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);
  const setTTSSpeed = useSettingsStore((s) => s.setTTSSpeed);

  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const asrLanguage = useSettingsStore((s) => s.asrLanguage);
  const asrProvidersConfig = useSettingsStore((s) => s.asrProvidersConfig);
  const setASRProvider = useSettingsStore((s) => s.setASRProvider);
  const setASRLanguage = useSettingsStore((s) => s.setASRLanguage);

  const enabledMap: Record<TabId, boolean> = {
    image: imageGenerationEnabled,
    video: videoGenerationEnabled,
    tts: ttsEnabled,
    asr: asrEnabled,
  };

  const enabledCount = [
    imageGenerationEnabled,
    videoGenerationEnabled,
    ttsEnabled,
    asrEnabled,
  ].filter(Boolean).length;

  const cfgOk = (
    configs: Record<string, { apiKey?: string; isServerConfigured?: boolean }>,
    id: string,
    needsKey: boolean,
  ) => !needsKey || !!configs[id]?.apiKey || !!configs[id]?.isServerConfigured;

  const ttsSpeedRange = TTS_PROVIDERS[ttsProviderId]?.speedRange;

  // ─── Dynamic browser voices ───
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  // ─── Grouped select data (only available providers) ───
  const imageGroups = useMemo(
    () =>
      Object.values(IMAGE_PROVIDERS)
        .filter((p) => cfgOk(imageProvidersConfig, p.id, p.requiresApiKey))
        .map((p) => ({
          groupId: p.id,
          groupName: p.name,
          groupIcon: IMAGE_PROVIDER_ICONS[p.id],
          available: true,
          items: [...p.models, ...(imageProvidersConfig[p.id]?.customModels || [])].map((m) => ({
            id: m.id,
            name: m.name,
          })),
        })),
    [imageProvidersConfig],
  );

  const videoGroups = useMemo(
    () =>
      Object.values(VIDEO_PROVIDERS)
        .filter((p) => cfgOk(videoProvidersConfig, p.id, p.requiresApiKey))
        .map((p) => ({
          groupId: p.id,
          groupName: p.name,
          groupIcon: VIDEO_PROVIDER_ICONS[p.id],
          available: true,
          items: [...p.models, ...(videoProvidersConfig[p.id]?.customModels || [])].map((m) => ({
            id: m.id,
            name: m.name,
          })),
        })),
    [videoProvidersConfig],
  );

  // TTS: grouped by provider, voices as items (matching Image/Video pattern)
  // Browser-native voices are split into sub-groups by language.
  const ttsGroups = useMemo(() => {
    const groups: SelectGroupData[] = [];

    for (const p of Object.values(TTS_PROVIDERS)) {
      if (p.requiresApiKey && !cfgOk(ttsProvidersConfig, p.id, p.requiresApiKey)) continue;

      const providerName = getTTSProviderName(p.id, t);

      // For browser-native-tts, split voices by language
      if (p.id === 'browser-native-tts' && browserVoices.length > 0) {
        const byLang = new Map<string, SpeechSynthesisVoice[]>();
        for (const v of browserVoices) {
          const langKey = v.lang.split('-')[0]; // "zh-CN" → "zh"
          if (!byLang.has(langKey)) byLang.set(langKey, []);
          byLang.get(langKey)!.push(v);
        }
        for (const [langKey, voices] of byLang) {
          const langLabel = LANG_LABELS[langKey] || langKey;
          groups.push({
            groupId: p.id,
            groupName: `${providerName} · ${langLabel}`,
            groupIcon: p.icon,
            available: true,
            items: voices.map((v) => ({ id: v.voiceURI, name: v.name })),
          });
        }
        continue;
      }

      groups.push({
        groupId: p.id,
        groupName: providerName,
        groupIcon: p.icon,
        available: true,
        items: getTTSVoices(p.id).map((v) => ({
          id: v.id,
          name: getVoiceDisplayName(v.name, locale),
        })),
      });
    }

    return groups;
  }, [ttsProvidersConfig, locale, browserVoices, t]);

  // TTS preview
  const handlePreview = useCallback(async () => {
    if (previewing) {
      stopPreview();
      return;
    }
    try {
      const providerConfig = ttsProvidersConfig[ttsProviderId];
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: ttsProviderId,
        voice: ttsVoice,
        speed: ttsSpeed,
        apiKey: providerConfig?.apiKey,
        baseUrl: providerConfig?.baseUrl,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : t('settings.ttsTestFailed');
      toast.error(message);
    }
  }, [
    previewing,
    startPreview,
    stopPreview,
    t,
    ttsProviderId,
    ttsProvidersConfig,
    ttsSpeed,
    ttsVoice,
  ]);

  // ASR: only available providers
  const asrGroups = useMemo(
    () =>
      Object.values(ASR_PROVIDERS)
        .filter((p) => cfgOk(asrProvidersConfig, p.id, p.requiresApiKey))
        .map((p) => ({
          groupId: p.id,
          groupName: p.name,
          groupIcon: p.icon,
          available: true,
          items: getASRSupportedLanguages(p.id).map((l) => ({
            id: l,
            name: l,
          })),
        })),
    [asrProvidersConfig],
  );

  // Auto-select first enabled tab on open
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      stopPreview();
    }
    setOpen(isOpen);
    if (isOpen) {
      const first = (['image', 'video', 'tts', 'asr'] as TabId[]).find((id) => enabledMap[id]);
      setActiveTab(first || 'image');
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border',
            enabledCount > 0
              ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200/60 dark:border-violet-700/50'
              : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 border-border/50',
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          {imageGenerationEnabled && <ImageIcon className="size-3.5" />}
          {videoGenerationEnabled && <Video className="size-3.5" />}
          {ttsEnabled && <Volume2 className="size-3.5" />}
          {asrEnabled && <Mic className="size-3.5" />}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="bottom" avoidCollisions={false} className="w-80 p-0">
        {/* ── Tab bar (segmented control) ── */}
        <div className="p-2 pb-0">
          <div className="flex gap-0.5 p-0.5 bg-muted/60 rounded-lg">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const isEnabled = enabledMap[tab.id];
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all relative',
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground/80',
                  )}
                >
                  <Icon className="size-3.5" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {isEnabled && !isActive && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-violet-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Tab content ── */}
        <div className="p-3 pt-2.5">
          {activeTab === 'image' && (
            <TabPanel
              icon={ImageIcon}
              label={t('media.imageCapability')}
              enabled={imageGenerationEnabled}
              onToggle={setImageGenerationEnabled}
            >
              <GroupedSelect
                groups={imageGroups}
                selectedGroupId={imageProviderId}
                selectedItemId={imageModelId}
                onSelect={(gid, iid) => {
                  setImageProvider(gid as ImageProviderId);
                  setImageModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'video' && (
            <TabPanel
              icon={Video}
              label={t('media.videoCapability')}
              enabled={videoGenerationEnabled}
              onToggle={setVideoGenerationEnabled}
            >
              <GroupedSelect
                groups={videoGroups}
                selectedGroupId={videoProviderId}
                selectedItemId={videoModelId}
                onSelect={(gid, iid) => {
                  setVideoProvider(gid as VideoProviderId);
                  setVideoModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'tts' && (
            <TabPanel
              icon={Volume2}
              label={t('media.ttsCapability')}
              enabled={ttsEnabled}
              onToggle={setTTSEnabled}
            >
              {/* Provider + Voice grouped select + preview */}
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <GroupedSelect
                    groups={ttsGroups}
                    selectedGroupId={ttsProviderId}
                    selectedItemId={ttsVoice}
                    onSelect={(gid, iid) => {
                      if (gid !== ttsProviderId) {
                        setTTSProvider(gid as TTSProviderId);
                      }
                      setTTSVoice(iid);
                    }}
                  />
                </div>
                <button
                  onClick={handlePreview}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all shrink-0',
                    previewing
                      ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {previewing ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  {previewing ? t('toolbar.ttsPreviewing') : t('toolbar.ttsPreview')}
                </button>
              </div>
              {ttsSpeedRange && (
                <div className="flex items-center gap-2.5 mt-2.5">
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">
                    {t('media.speed')}
                  </span>
                  <Slider
                    value={[ttsSpeed]}
                    onValueChange={(value) => setTTSSpeed(value[0])}
                    min={ttsSpeedRange.min}
                    max={ttsSpeedRange.max}
                    step={0.1}
                    className="flex-1"
                  />
                  <span className="text-[10px] text-muted-foreground tabular-nums w-7 text-right">
                    {ttsSpeed.toFixed(1)}x
                  </span>
                </div>
              )}
            </TabPanel>
          )}

          {activeTab === 'asr' && (
            <TabPanel
              icon={Mic}
              label={t('media.asrCapability')}
              enabled={asrEnabled}
              onToggle={setASREnabled}
            >
              <GroupedSelect
                groups={asrGroups}
                selectedGroupId={asrProviderId}
                selectedItemId={asrLanguage}
                onSelect={(gid, iid) => {
                  setASRProvider(gid as ASRProviderId);
                  setASRLanguage(iid);
                }}
              />
            </TabPanel>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-border/40">
          <button
            onClick={() => {
              setOpen(false);
              onSettingsOpen(activeTab);
            }}
            className="w-full flex items-center justify-between px-3.5 py-2.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <span>{t('toolbar.advancedSettings')}</span>
            <ChevronRight className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Tab panel: header (label + switch) + optional body ───
function TabPanel({
  icon: Icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <Icon
          className={cn(
            'size-4 shrink-0 transition-colors',
            enabled ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground/50',
          )}
        />
        <span
          className={cn(
            'flex-1 text-sm font-medium transition-colors',
            !enabled && 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          className="scale-[0.85] origin-right"
        />
      </div>
      {enabled && children}
    </div>
  );
}

// ─── Grouped provider+model select ───
interface SelectGroupData {
  groupId: string;
  groupName: string;
  groupIcon?: string;
  available: boolean;
  items: Array<{ id: string; name: string }>;
}

function GroupedSelect({
  groups,
  selectedGroupId,
  selectedItemId,
  onSelect,
}: {
  groups: SelectGroupData[];
  selectedGroupId: string;
  selectedItemId: string;
  onSelect: (groupId: string, itemId: string) => void;
}) {
  const composite = `${selectedGroupId}::${selectedItemId}`;
  // When multiple groups share the same groupId (e.g. browser-native-tts split by language),
  // find the sub-group that actually contains the selected item.
  const selectedGroup =
    groups.find(
      (g) => g.groupId === selectedGroupId && g.items.some((item) => item.id === selectedItemId),
    ) || groups.find((g) => g.groupId === selectedGroupId);

  return (
    <Select
      value={composite}
      onValueChange={(v) => {
        const sep = v.indexOf('::');
        if (sep === -1) return;
        onSelect(v.slice(0, sep), v.slice(sep + 2));
      }}
    >
      <SelectTrigger className="h-8 w-full rounded-lg border-border/40 bg-background/80 hover:bg-muted/40 shadow-none text-xs focus:ring-1 focus:ring-ring/30 px-2.5">
        <span className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {selectedGroup?.groupIcon && (
            <img src={selectedGroup.groupIcon} alt="" className="size-4 rounded-sm shrink-0" />
          )}
          <span className="font-medium truncate">{selectedGroup?.groupName}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-muted-foreground truncate">
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group, i) => (
          <Fragment key={`${group.groupId}-${i}`}>
            {i > 0 && <SelectSeparator />}
            <SelectGroup>
              <SelectLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                {group.groupIcon && (
                  <img
                    src={group.groupIcon}
                    alt=""
                    className={cn('size-3.5 rounded-sm', !group.available && 'opacity-40')}
                  />
                )}
                {group.groupName}
              </SelectLabel>
              {group.items.map((item) => (
                <SelectItem
                  key={`${group.groupId}::${item.id}`}
                  value={`${group.groupId}::${item.id}`}
                  disabled={!group.available}
                  className="text-xs"
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
