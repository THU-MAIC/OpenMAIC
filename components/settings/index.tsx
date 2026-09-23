'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  IMAGE_PROVIDER_NAMES,
  VIDEO_PROVIDER_NAMES,
} from '@/components/settings/media-provider-names';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  X,
  Trash2,
  Box,
  Settings,
  CheckCircle2,
  XCircle,
  FileText,
  Image as ImageIcon,
  Film,
  Search,
  Volume2,
  Mic,
  MoreHorizontal,
  Plus,
  CreditCard,
  Boxes,
  GraduationCap,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { toast } from 'sonner';
import { type ProviderId } from '@/lib/ai/providers';
import { PROVIDERS, MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import { cn } from '@/lib/utils';
import { createCustomProviderSettings, modelInfoFromId } from './utils';
import { ProviderList } from './provider-list';
import { ProviderConfigPanel } from './provider-config-panel';
import { PDFSettings } from './pdf-settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { ImageSettings } from './image-settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { VideoSettings } from './video-settings';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { VideoProviderId } from '@/lib/media/types';
import { TTSSettings } from './tts-settings';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { ASRSettings } from './asr-settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId } from '@/lib/audio/types';
import { WebSearchSettings } from './web-search-settings';
import { WEB_SEARCH_PROVIDERS, getWebSearchProviderDisplayName } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { GeneralSettings } from './general-settings';
import { SkillSettings } from './skill-settings';
import { TokenPlanSettings } from './token-plan-settings';
import { CourseModelConfigPanel } from './course-model-config';
import { ModelEditDialog } from './model-edit-dialog';
import { AddProviderDialog, type NewProviderData } from './add-provider-dialog';
import { AddAudioProviderDialog, type NewAudioProviderData } from './add-audio-provider-dialog';
import { isCustomTTSProvider, isCustomASRProvider } from '@/lib/audio/types';
import { resolveASRProviderName, resolveTTSProviderName } from '@/lib/audio/provider-display';
import type { SettingsSection, EditingModel } from '@/lib/types/settings';

// ─── Provider List Column (reusable, 模型服务分区内的服务列表) ───
// 样式对齐原型 model-services-panel：圆角头像 + 两行（名称 + 配置状态点），
// 选中项为描边卡片，添加入口是列表尾部的幽灵行。
function ProviderListColumn<T extends string>({
  providers,
  configs,
  selectedId,
  onSelect,
  t,
  onAdd,
}: {
  providers: Array<{ id: T; name: string; icon?: string; requiresApiKey?: boolean }>;
  configs: Record<
    string,
    { apiKey?: string; isServerConfigured?: boolean; requiresApiKey?: boolean }
  >;
  selectedId: T;
  onSelect: (id: T) => void;
  t: (key: string) => string;
  onAdd?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto p-1">
        {providers.map((provider) => {
          const config = configs[provider.id];
          // 注册表声明 requiresApiKey: false 的服务（如浏览器原生 ASR/TTS）无需
          // 任何凭证，天然视为已配置。
          const configured =
            !!config?.isServerConfigured ||
            !!config?.apiKey ||
            config?.requiresApiKey === false ||
            provider.requiresApiKey === false;
          const active = selectedId === provider.id;
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
                    alt={provider.name}
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
          );
        })}
        {onAdd && (
          <button
            onClick={onAdd}
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

// ─── Helper: get TTS/ASR provider display name ───
// The id→i18n-key tables live in lib/audio/provider-display so the generation
// toolbar resolves provider names the same way this dialog does.
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  if (isCustomTTSProvider(providerId)) {
    const cfg = useSettingsStore.getState().ttsProvidersConfig[providerId];
    return cfg?.customName || providerId;
  }
  return resolveTTSProviderName(providerId, t);
}

function getASRProviderName(providerId: ASRProviderId, t: (key: string) => string): string {
  if (isCustomASRProvider(providerId)) {
    const cfg = useSettingsStore.getState().asrProvidersConfig[providerId];
    return cfg?.customName || providerId;
  }
  return resolveASRProviderName(providerId, t);
}

// ─── Image/Video provider name helpers ───
const IMAGE_PROVIDER_ICONS: Record<ImageProviderId, string> = {
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

const VIDEO_PROVIDER_ICONS: Record<VideoProviderId, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  'minimax-video': '/logos/minimax.svg',
  'grok-video': '/logos/grok.svg',
  'openrouter-video': '/logos/openrouter.svg',
  happyhorse: '/logos/qwen.svg',
};

/** 「模型服务」分区内的服务 tab：沿用旧一级分区的值与面板组件。 */
export type ServiceTab = Extract<
  SettingsSection,
  'providers' | 'image' | 'video' | 'tts' | 'asr' | 'pdf' | 'web-search'
>;

const SERVICE_TABS = [
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

const SERVICE_TAB_ICONS: Record<ServiceTab, typeof Boxes> = {
  providers: Box,
  image: ImageIcon,
  video: Film,
  tts: Volume2,
  asr: Mic,
  pdf: FileText,
  'web-search': Search,
};

const SERVICE_TAB_DESCRIPTIONS: Record<ServiceTab, string> = {
  providers: 'settings.modelServices.desc.providers',
  image: 'settings.modelServices.desc.image',
  video: 'settings.modelServices.desc.video',
  tts: 'settings.modelServices.desc.tts',
  asr: 'settings.modelServices.desc.asr',
  pdf: 'settings.modelServices.desc.pdf',
  'web-search': 'settings.modelServices.desc.webSearch',
};

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onOpenChange, initialSection }: SettingsDialogProps) {
  const { t } = useI18n();

  // Get settings from store
  const providerId = useSettingsStore((state) => state.providerId);
  const _modelId = useSettingsStore((state) => state.modelId);
  const providersConfig = useSettingsStore((state) => state.providersConfig);
  const pdfProviderId = useSettingsStore((state) => state.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((state) => state.pdfProvidersConfig);
  const webSearchProviderId = useSettingsStore((state) => state.webSearchProviderId);
  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const imageProviderId = useSettingsStore((state) => state.imageProviderId);
  const imageProvidersConfig = useSettingsStore((state) => state.imageProvidersConfig);
  const videoProviderId = useSettingsStore((state) => state.videoProviderId);
  const videoProvidersConfig = useSettingsStore((state) => state.videoProvidersConfig);
  const ttsProviderId = useSettingsStore((state) => state.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const asrProviderId = useSettingsStore((state) => state.asrProviderId);
  const asrProvidersConfig = useSettingsStore((state) => state.asrProvidersConfig);

  // Store actions
  const setProviderConfig = useSettingsStore((state) => state.setProviderConfig);
  const setProvidersConfig = useSettingsStore((state) => state.setProvidersConfig);
  const setTTSProvider = useSettingsStore((state) => state.setTTSProvider);
  const setASRProvider = useSettingsStore((state) => state.setASRProvider);
  // 「启用此提供方」（授权层开关）所需的各模态 config setter
  const setImageProviderConfig = useSettingsStore((state) => state.setImageProviderConfig);
  const setVideoProviderConfig = useSettingsStore((state) => state.setVideoProviderConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const setASRProviderConfig = useSettingsStore((state) => state.setASRProviderConfig);
  const setPDFProviderConfig = useSettingsStore((state) => state.setPDFProviderConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  // Navigation
  const [activeSection, setActiveSection] = useState<SettingsSection>('token-plan');
  // 「模型服务」分区内的服务 tab（沿用旧一级分区值）
  const [serviceTab, setServiceTab] = useState<ServiceTab>('providers');
  // TTS/ASR 列表是「浏览配置」而非「切换使用」：本地选中态（默认跟随全局），
  // 点击列表不再直接改全局 ttsProviderId/asrProviderId 并重置音色——实际的
  // 使用选择在「课程模型配置」的语音合成节点里做。
  const [ttsBrowseId, setTtsBrowseId] = useState<TTSProviderId | null>(null);
  const [asrBrowseId, setAsrBrowseId] = useState<ASRProviderId | null>(null);
  // 旧的七个模态面板只在 model-services 分区内按 tab 渲染；其它分区下为 null
  const serviceSection: ServiceTab | null = activeSection === 'model-services' ? serviceTab : null;
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>(providerId);
  const [selectedPdfProviderId, setSelectedPdfProviderId] = useState<PDFProviderId>(pdfProviderId);
  const [selectedWebSearchProviderId, setSelectedWebSearchProviderId] =
    useState<WebSearchProviderId>(webSearchProviderId);
  // `imageProviderId`/`videoProviderId` are empty until a provider is actually
  // chosen (first-run auto-config leaves them blank when the server reports no
  // media provider). Opening the panel on an empty id selected nothing: the
  // header rendered the missing key as "settings.undefined", and Test
  // Connection posted a blank `x-image-provider`/`x-video-provider`, so it
  // failed with "No image/video provider configured" no matter what was typed.
  // Fall back to the first catalog entry so the panel always has a selection.
  const [selectedImageProviderId, setSelectedImageProviderId] = useState<ImageProviderId>(
    imageProviderId || (Object.keys(IMAGE_PROVIDERS)[0] as ImageProviderId),
  );
  const [selectedVideoProviderId, setSelectedVideoProviderId] = useState<VideoProviderId>(
    videoProviderId || (Object.keys(VIDEO_PROVIDERS)[0] as VideoProviderId),
  );
  // Navigate to initialSection when dialog opens
  useEffect(() => {
    if (open && initialSection) {
      if (SERVICE_TABS.includes(initialSection as ServiceTab)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync service tab from legacy section value
        setServiceTab(initialSection as ServiceTab);

        setActiveSection('model-services');
      } else {
        setActiveSection(initialSection);
      }
    }
  }, [open, initialSection]);

  // Model editing state
  const [editingModel, setEditingModel] = useState<EditingModel | null>(null);
  const [showModelDialog, setShowModelDialog] = useState(false);

  // Provider deletion confirmation
  const [providerToDelete, setProviderToDelete] = useState<ProviderId | null>(null);

  // Add provider dialog
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false);
  const [showAddTTSProviderDialog, setShowAddTTSProviderDialog] = useState(false);
  const [showAddASRProviderDialog, setShowAddASRProviderDialog] = useState(false);
  const addCustomTTSProvider = useSettingsStore((state) => state.addCustomTTSProvider);
  const addCustomASRProvider = useSettingsStore((state) => state.addCustomASRProvider);

  const handleAddTTSProvider = (data: NewAudioProviderData) => {
    const id = `custom-tts-${Date.now()}` as TTSProviderId;
    addCustomTTSProvider(id, data.name, data.baseUrl, data.requiresApiKey, data.defaultModel);
  };

  const handleAddASRProvider = (data: NewAudioProviderData) => {
    const id = `custom-asr-${Date.now()}` as ASRProviderId;
    addCustomASRProvider(id, data.name, data.baseUrl, data.requiresApiKey);
  };

  // Save status indicator
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // Resizable sidebar width（服务列表列宽固定，对齐原型，不再可拖拽）
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      setIsResizing(true);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startWidth } = resizeRef.current;
      const delta = e.clientX - startX;
      const newWidth = Math.max(120, Math.min(360, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      resizeRef.current = null;
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing]);

  const handleProviderSelect = (pid: ProviderId) => {
    setSelectedProviderId(pid);
  };

  const handleProviderConfigChange = (
    pid: ProviderId,
    apiKey: string,
    baseUrl: string,
    requiresApiKey: boolean,
  ) => {
    setProviderConfig(pid, {
      apiKey,
      baseUrl,
      requiresApiKey,
    });
  };

  const handleProviderConfigSave = () => {
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
  };

  const selectedProvider = providersConfig[selectedProviderId]
    ? {
        id: selectedProviderId,
        name: providersConfig[selectedProviderId].name,
        type: providersConfig[selectedProviderId].type,
        defaultBaseUrl: providersConfig[selectedProviderId].defaultBaseUrl,
        baseUrlPlaceholder: PROVIDERS[selectedProviderId]?.baseUrlPlaceholder,
        supportsModelDiscovery: PROVIDERS[selectedProviderId]?.supportsModelDiscovery,
        alternateBaseUrls: PROVIDERS[selectedProviderId]?.alternateBaseUrls,
        icon: providersConfig[selectedProviderId].icon,
        requiresApiKey: providersConfig[selectedProviderId].requiresApiKey,
        models: providersConfig[selectedProviderId].models,
      }
    : undefined;

  // Handle model editing
  const handleEditModel = (pid: ProviderId, modelIndex: number) => {
    const allModels = providersConfig[pid]?.models || [];
    setEditingModel({
      providerId: pid,
      modelIndex,
      model: { ...allModels[modelIndex] },
    });
    setShowModelDialog(true);
  };

  const handleAddModel = () => {
    setEditingModel({
      providerId: selectedProviderId,
      modelIndex: null,
      model: {
        id: '',
        name: '',
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
        },
      },
    });
    setShowModelDialog(true);
  };

  const handleDeleteModel = (pid: ProviderId, modelIndex: number) => {
    const currentModels = providersConfig[pid]?.models || [];
    const newModels = currentModels.filter((_, i) => i !== modelIndex);
    setProviderConfig(pid, { models: newModels });
  };

  // Merge probed model ids into the provider's model list. Previously
  // probe-derived entries (`source: 'probed'`) are dropped first so a re-fetch
  // (after the user changes base URL / API key) REPLACES the stale set instead
  // of accumulating dead ids. Catalog and manually-added models are preserved.
  // `modelInfoFromId(id, pid)` keeps built-in thinking capability so the
  // thinking control isn't silently hidden for fetched built-in models.
  const handleModelsFetched = (pid: ProviderId, fetchedIds: string[]): number => {
    const currentModels = providersConfig[pid]?.models || [];
    const kept = currentModels.filter((m) => m.source !== 'probed');
    const keptIds = new Set(kept.map((m) => m.id));
    const additions = fetchedIds
      .filter((id) => !keptIds.has(id))
      .map((id) => ({ ...modelInfoFromId(id, pid), source: 'probed' as const }));
    const next = [...kept, ...additions];
    // Write when the set changed at all — additions, or stale probed ids pruned.
    if (additions.length > 0 || next.length !== currentModels.length) {
      setProviderConfig(pid, { models: next });
    }
    return additions.length;
  };

  const handleAutoSaveModel = () => {
    if (!editingModel) return;
    const { providerId: pid, modelIndex, model } = editingModel;
    if (!model.id.trim()) return;
    const currentModels = providersConfig[pid]?.models || [];
    let newModels: typeof currentModels;
    let newModelIndex = modelIndex;

    if (modelIndex === null) {
      const existingIndex = currentModels.findIndex((m) => m.id === model.id);
      if (existingIndex >= 0) {
        newModels = [...currentModels];
        newModels[existingIndex] = model;
        newModelIndex = existingIndex;
      } else {
        newModels = [...currentModels, model];
        newModelIndex = newModels.length - 1;
      }
      setProviderConfig(pid, { models: newModels });
      setEditingModel({ ...editingModel, modelIndex: newModelIndex });
    } else {
      newModels = [...currentModels];
      newModels[modelIndex] = model;
      setProviderConfig(pid, { models: newModels });
    }
  };

  const handleSaveModel = () => {
    if (!editingModel) return;
    const { providerId: pid, modelIndex, model } = editingModel;
    if (!model.id.trim()) {
      toast.error(t('settings.modelIdRequired'));
      return;
    }
    const currentModels = providersConfig[pid]?.models || [];
    let newModels: typeof currentModels;
    if (modelIndex === null) {
      newModels = [...currentModels, model];
    } else {
      newModels = [...currentModels];
      newModels[modelIndex] = model;
    }
    setProviderConfig(pid, { models: newModels });
    setShowModelDialog(false);
    setEditingModel(null);
  };

  // Handle provider management
  const handleAddProvider = (providerData: NewProviderData) => {
    if (!providerData.name.trim()) {
      toast.error(t('settings.providerNameRequired'));
      return;
    }
    const newProviderId = `custom-${Date.now()}` as ProviderId;
    const updatedConfig = {
      ...providersConfig,
      [newProviderId]: createCustomProviderSettings({
        name: providerData.name,
        type: providerData.type,
        baseUrl: providerData.baseUrl,
        icon: providerData.icon,
        requiresApiKey: providerData.requiresApiKey,
        modelsUrl: providerData.modelsUrl,
      }),
    };
    setProvidersConfig(updatedConfig);
    setShowAddProviderDialog(false);
    setSelectedProviderId(newProviderId);
  };

  const handleDeleteProvider = (pid: ProviderId) => {
    if (providersConfig[pid]?.isBuiltIn) {
      toast.error(t('settings.cannotDeleteBuiltIn'));
      return;
    }
    setProviderToDelete(pid);
  };

  const confirmDeleteProvider = () => {
    if (!providerToDelete) return;
    const pid = providerToDelete;
    const updatedConfig = { ...providersConfig };
    delete updatedConfig[pid];
    // setProvidersConfig re-resolves the global (providerId, modelId)
    // selection at the source (#580 invariant) — keep a still-usable
    // provider, fall back to another usable one, or go to State A. No
    // hand-rolled "pick the first config key" here: that ignored usability
    // and could re-select an invalid/unusable provider.
    setProvidersConfig(updatedConfig);
    if (selectedProviderId === pid) {
      // Settings-panel tab only (local UI), independent of model selection.
      const firstRemainingPid = Object.keys(updatedConfig)[0] as ProviderId | undefined;
      setSelectedProviderId(firstRemainingPid || 'openai');
    }
    setProviderToDelete(null);
  };

  const handleResetProvider = (pid: ProviderId) => {
    const provider = PROVIDERS[pid];
    if (!provider) return;
    setProviderConfig(pid, { models: [...provider.models] });
    toast.success(t('settings.resetSuccess'));
  };

  // Get all providers from providersConfig
  const allProviders = Object.entries(providersConfig).map(([id, config]) => ({
    id: id as ProviderId,
    name: config.name,
    type: config.type,
    defaultBaseUrl: config.defaultBaseUrl,
    icon: config.icon,
    requiresApiKey: config.requiresApiKey,
    apiKey: config.apiKey,
    models: config.models,
    isServerConfigured: config.isServerConfigured,
  }));

  // Get header content based on section
  const getHeaderContent = () => {
    if (activeSection === 'model-services') {
      return (
        <div>
          <h2 className="text-lg font-semibold">{t('settings.modelServices.nav')}</h2>
          <p className="text-xs text-muted-foreground">{t(SERVICE_TAB_DESCRIPTIONS[serviceTab])}</p>
        </div>
      );
    }
    switch (activeSection) {
      case 'course-models':
        return <h2 className="text-lg font-semibold">{t('settings.courseModels.nav')}</h2>;
      case 'general':
        return <h2 className="text-lg font-semibold">{t('settings.systemSettings')}</h2>;
      case 'skills':
        return (
          <>
            <Sparkles className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('settings.skills.title')}</h2>
          </>
        );
      case 'token-plan':
        return <h2 className="text-lg font-semibold">{t('settings.tokenPlan.nav')}</h2>;
      default:
        return null;
    }
  };

  // 「模型服务」面板顶部：当前服务的图标/名称 + 配置状态徽章（对齐原型）
  const getServicePanelHeader = () => {
    if (!serviceSection) return null;
    // registryRequiresApiKey: 注册表声明无需凭证（如浏览器原生 ASR）也视为已配置
    const configuredOf = (
      c?: { apiKey?: string; isServerConfigured?: boolean; requiresApiKey?: boolean },
      registryRequiresApiKey?: boolean,
    ) =>
      !!c?.isServerConfigured ||
      !!c?.apiKey ||
      c?.requiresApiKey === false ||
      registryRequiresApiKey === false;

    let icon: string | undefined;
    let name: string | undefined;
    let configured = false;
    let id = '';
    // 授权层「启用此提供方」开关：checked = 已配置且未被用户关闭
    let enabledFlag = false;
    let setProviderEnabled: ((checked: boolean) => void) | null = null;
    // 仅语言模型的自定义提供方可删除（删除入口在此提供方自己的头部条）
    let providerDeletable = false;
    switch (serviceSection) {
      case 'providers': {
        const cfg = providersConfig[selectedProviderId];
        if (!cfg) return null;
        const translationKey = `settings.providerNames.${selectedProviderId}`;
        const translated = t(translationKey);
        id = selectedProviderId;
        icon = cfg.icon;
        name = translated !== translationKey ? translated : cfg.name;
        configured = configuredOf(cfg);
        enabledFlag = cfg.enabled !== false;
        setProviderEnabled = (checked) =>
          setProviderConfig(selectedProviderId, { enabled: checked });
        providerDeletable = !cfg.isBuiltIn;
        break;
      }
      case 'pdf': {
        const p = PDF_PROVIDERS[selectedPdfProviderId];
        if (!p) return null;
        id = selectedPdfProviderId;
        icon = p.icon;
        name = p.name;
        configured = configuredOf(pdfProvidersConfig[selectedPdfProviderId], p.requiresApiKey);
        enabledFlag = pdfProvidersConfig[selectedPdfProviderId]?.enabled !== false;
        setProviderEnabled = (checked) =>
          setPDFProviderConfig(selectedPdfProviderId, { enabled: checked });
        break;
      }
      case 'web-search': {
        const p = WEB_SEARCH_PROVIDERS[selectedWebSearchProviderId];
        if (!p) return null;
        id = selectedWebSearchProviderId;
        icon = p.icon;
        name = getWebSearchProviderDisplayName(p.id, t);
        const wsCfg = webSearchProvidersConfig[selectedWebSearchProviderId];
        configured =
          configuredOf(wsCfg, p.requiresApiKey) &&
          !(wsCfg as { serverDisabled?: boolean })?.serverDisabled;
        enabledFlag = wsCfg?.enabled !== false;
        setProviderEnabled = (checked) =>
          setWebSearchProviderConfig(selectedWebSearchProviderId, { enabled: checked });
        break;
      }
      case 'image': {
        id = selectedImageProviderId;
        icon = IMAGE_PROVIDER_ICONS[selectedImageProviderId];
        name =
          t(`settings.${IMAGE_PROVIDER_NAMES[selectedImageProviderId]}`) ||
          IMAGE_PROVIDERS[selectedImageProviderId]?.name;
        configured = configuredOf(
          imageProvidersConfig[selectedImageProviderId],
          IMAGE_PROVIDERS[selectedImageProviderId]?.requiresApiKey,
        );
        enabledFlag = imageProvidersConfig[selectedImageProviderId]?.enabled !== false;
        setProviderEnabled = (checked) =>
          setImageProviderConfig(selectedImageProviderId, { enabled: checked });
        break;
      }
      case 'video': {
        id = selectedVideoProviderId;
        icon = VIDEO_PROVIDER_ICONS[selectedVideoProviderId];
        name =
          t(`settings.${VIDEO_PROVIDER_NAMES[selectedVideoProviderId]}`) ||
          VIDEO_PROVIDERS[selectedVideoProviderId]?.name;
        configured = configuredOf(
          videoProvidersConfig[selectedVideoProviderId],
          VIDEO_PROVIDERS[selectedVideoProviderId]?.requiresApiKey,
        );
        enabledFlag = videoProvidersConfig[selectedVideoProviderId]?.enabled !== false;
        setProviderEnabled = (checked) =>
          setVideoProviderConfig(selectedVideoProviderId, { enabled: checked });
        break;
      }
      case 'tts': {
        const ttsId = ttsBrowseId ?? ttsProviderId;
        id = ttsId;
        icon = TTS_PROVIDERS[ttsId as keyof typeof TTS_PROVIDERS]?.icon;
        name = getTTSProviderName(ttsId, t);
        configured =
          configuredOf(
            ttsProvidersConfig[ttsId],
            TTS_PROVIDERS[ttsId as keyof typeof TTS_PROVIDERS]?.requiresApiKey,
          ) && !ttsProvidersConfig[ttsId]?.serverDisabled;
        enabledFlag = ttsProvidersConfig[ttsId]?.enabled !== false;
        setProviderEnabled = (checked) => setTTSProviderConfig(ttsId, { enabled: checked });
        break;
      }
      case 'asr': {
        const asrId = asrBrowseId ?? asrProviderId;
        id = asrId;
        icon = ASR_PROVIDERS[asrId as keyof typeof ASR_PROVIDERS]?.icon;
        name = getASRProviderName(asrId, t);
        configured =
          configuredOf(
            asrProvidersConfig[asrId],
            ASR_PROVIDERS[asrId as keyof typeof ASR_PROVIDERS]?.requiresApiKey,
          ) && !asrProvidersConfig[asrId]?.serverDisabled;
        enabledFlag = asrProvidersConfig[asrId]?.enabled !== false;
        setProviderEnabled = (checked) => setASRProviderConfig(asrId, { enabled: checked });
        break;
      }
    }
    if (!name) return null;
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
                  MONO_LOGO_PROVIDERS.has(id) && 'dark:invert',
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
          {providerDeletable && (
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
                  onSelect={() => handleDeleteProvider(selectedProviderId)}
                >
                  <Trash2 className="size-4" />
                  {t('settings.deleteProvider')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* 授权层开关：关闭后此提供方不再出现在课程模型配置（语音合成还
              包括音色选择）中；未配置时不可开启。 */}
          <Tooltip>
            {/* 垫一层 span：TooltipTrigger asChild 会把自己的 data-state
                (open/closed) 合并到子元素上，直接套 Switch 会覆盖其
                checked/unchecked 状态，导致开关的选中配色失效。 */}
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Switch
                  checked={configured && enabledFlag}
                  disabled={!configured || !setProviderEnabled}
                  onCheckedChange={(checked) => setProviderEnabled?.(checked)}
                  aria-label={t('settings.enableThisProvider')}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t('settings.enableThisProviderHint')}
            </TooltipContent>
          </Tooltip>
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85vh] p-0 gap-0 block" showCloseButton={false}>
        <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
        <div className="flex h-full overflow-hidden">
          {/* Left Sidebar - Navigation */}
          <div className="flex-shrink-0 bg-muted/30 p-3 space-y-1" style={{ width: sidebarWidth }}>
            <button
              onClick={() => setActiveSection('token-plan')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'token-plan'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <CreditCard className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.tokenPlan.nav')}</span>
            </button>

            <button
              onClick={() => setActiveSection('model-services')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'model-services'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Boxes className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.modelServices.nav')}</span>
            </button>

            <button
              onClick={() => setActiveSection('course-models')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'course-models'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <GraduationCap className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.courseModels.nav')}</span>
            </button>

            <button
              onClick={() => setActiveSection('skills')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'skills'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.skills.nav')}</span>
            </button>

            <button
              onClick={() => setActiveSection('general')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'general'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Settings className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.systemSettings')}</span>
            </button>
          </div>

          {/* Sidebar resize handle */}
          <div
            onMouseDown={(e) => handleResizeStart(e)}
            className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
          >
            <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Right - Configuration Panel */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b">
              <div className="flex items-center gap-3">{getHeaderContent()}</div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Content */}
            <div
              className={cn(
                'p-5',
                activeSection === 'model-services'
                  ? 'flex min-h-0 flex-1 flex-col pt-3'
                  : 'flex-1 overflow-y-auto',
              )}
            >
              {activeSection === 'general' && <GeneralSettings />}

              {activeSection === 'skills' && <SkillSettings />}

              {activeSection === 'token-plan' && <TokenPlanSettings />}

              {activeSection === 'course-models' && <CourseModelConfigPanel />}

              {activeSection === 'model-services' && (
                <div className="flex h-full min-h-0 flex-col">
                  {/* 七个服务的胶囊 tab（收拢后的一级列） */}
                  <div className="flex gap-1 overflow-x-auto pb-3">
                    {SERVICE_TABS.map((tab) => {
                      const Icon = SERVICE_TAB_ICONS[tab];
                      const active = serviceTab === tab;
                      return (
                        <button
                          key={tab}
                          onClick={() => setServiceTab(tab)}
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors',
                            active
                              ? 'bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15'
                              : 'text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <Icon className="size-3.5" />
                          {t(SERVICE_TAB_LABELS[tab])}
                        </button>
                      );
                    })}
                  </div>

                  {/* provider 列表 + 配置面板（统一容器，对齐原型） */}
                  <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border/50">
                    {/* 服务列表 */}
                    <div className="w-52 shrink-0 border-r border-border/50 bg-muted/20 p-2">
                      {serviceTab === 'providers' && (
                        <ProviderList
                          providers={allProviders}
                          selectedProviderId={selectedProviderId}
                          onSelect={handleProviderSelect}
                          onAddProvider={() => setShowAddProviderDialog(true)}
                        />
                      )}
                      {serviceTab === 'pdf' && (
                        <ProviderListColumn
                          providers={Object.values(PDF_PROVIDERS)}
                          configs={pdfProvidersConfig}
                          selectedId={selectedPdfProviderId}
                          onSelect={setSelectedPdfProviderId}
                          t={t}
                        />
                      )}
                      {serviceTab === 'web-search' && (
                        <ProviderListColumn
                          providers={Object.values(WEB_SEARCH_PROVIDERS).map((provider) => ({
                            ...provider,
                            name: getWebSearchProviderDisplayName(provider.id, t),
                          }))}
                          configs={webSearchProvidersConfig}
                          selectedId={selectedWebSearchProviderId}
                          onSelect={setSelectedWebSearchProviderId}
                          t={t}
                        />
                      )}
                      {serviceTab === 'image' && (
                        <ProviderListColumn
                          providers={Object.values(IMAGE_PROVIDERS).map((p) => ({
                            id: p.id,
                            name: t(`settings.${IMAGE_PROVIDER_NAMES[p.id]}`) || p.name,
                            icon: IMAGE_PROVIDER_ICONS[p.id],
                            requiresApiKey: p.requiresApiKey,
                          }))}
                          configs={imageProvidersConfig}
                          selectedId={selectedImageProviderId}
                          onSelect={setSelectedImageProviderId}
                          t={t}
                        />
                      )}
                      {serviceTab === 'video' && (
                        <ProviderListColumn
                          providers={Object.values(VIDEO_PROVIDERS).map((p) => ({
                            id: p.id,
                            name: t(`settings.${VIDEO_PROVIDER_NAMES[p.id]}`) || p.name,
                            icon: VIDEO_PROVIDER_ICONS[p.id],
                            requiresApiKey: p.requiresApiKey,
                          }))}
                          configs={videoProvidersConfig}
                          selectedId={selectedVideoProviderId}
                          onSelect={setSelectedVideoProviderId}
                          t={t}
                        />
                      )}
                      {serviceTab === 'tts' && (
                        <ProviderListColumn
                          providers={[
                            ...Object.values(TTS_PROVIDERS).map((p) => ({
                              id: p.id,
                              name: getTTSProviderName(p.id, t),
                              icon: p.icon,
                              requiresApiKey: p.requiresApiKey,
                            })),
                            ...Object.entries(ttsProvidersConfig)
                              .filter(([id]) => isCustomTTSProvider(id))
                              .map(([id, cfg]) => ({
                                id: id as TTSProviderId,
                                name: cfg.customName || id,
                                icon: undefined,
                              })),
                          ]}
                          configs={ttsProvidersConfig}
                          selectedId={ttsBrowseId ?? ttsProviderId}
                          onSelect={setTtsBrowseId}
                          t={t}
                          onAdd={() => setShowAddTTSProviderDialog(true)}
                        />
                      )}
                      {serviceTab === 'asr' && (
                        <ProviderListColumn
                          providers={[
                            ...Object.values(ASR_PROVIDERS).map((p) => ({
                              id: p.id,
                              name: getASRProviderName(p.id, t),
                              icon: p.icon,
                              requiresApiKey: p.requiresApiKey,
                            })),
                            ...Object.entries(asrProvidersConfig)
                              .filter(([id]) => isCustomASRProvider(id))
                              .map(([id, cfg]) => ({
                                id: id as ASRProviderId,
                                name: cfg.customName || id,
                                icon: undefined,
                              })),
                          ]}
                          configs={asrProvidersConfig}
                          selectedId={asrBrowseId ?? asrProviderId}
                          onSelect={setAsrBrowseId}
                          t={t}
                          onAdd={() => setShowAddASRProviderDialog(true)}
                        />
                      )}
                    </div>

                    {/* 配置面板 */}
                    <div className="min-w-0 flex-1 overflow-y-auto p-4">
                      {getServicePanelHeader()}

                      {serviceSection === 'providers' && selectedProvider && (
                        <div className="mt-4">
                          <ProviderConfigPanel
                            provider={selectedProvider}
                            initialApiKey={providersConfig[selectedProviderId]?.apiKey || ''}
                            initialBaseUrl={providersConfig[selectedProviderId]?.baseUrl || ''}
                            initialRequiresApiKey={
                              providersConfig[selectedProviderId]?.requiresApiKey ?? true
                            }
                            providersConfig={providersConfig}
                            onConfigChange={(apiKey, baseUrl, requiresApiKey) =>
                              handleProviderConfigChange(
                                selectedProviderId,
                                apiKey,
                                baseUrl,
                                requiresApiKey,
                              )
                            }
                            onSave={handleProviderConfigSave}
                            onEditModel={(index) => handleEditModel(selectedProviderId, index)}
                            onDeleteModel={(index) => handleDeleteModel(selectedProviderId, index)}
                            onAddModel={handleAddModel}
                            onModelsFetched={(ids) => handleModelsFetched(selectedProviderId, ids)}
                            modelsUrl={providersConfig[selectedProviderId]?.modelsUrl}
                            onResetToDefault={() => handleResetProvider(selectedProviderId)}
                            isBuiltIn={providersConfig[selectedProviderId]?.isBuiltIn ?? true}
                          />
                        </div>
                      )}

                      {serviceSection === 'pdf' && (
                        <div className="mt-4">
                          <PDFSettings selectedProviderId={selectedPdfProviderId} />
                        </div>
                      )}
                      {serviceSection === 'web-search' && (
                        <div className="mt-4">
                          <WebSearchSettings selectedProviderId={selectedWebSearchProviderId} />
                        </div>
                      )}
                      {serviceSection === 'image' && (
                        <div className="mt-4">
                          <ImageSettings selectedProviderId={selectedImageProviderId} />
                        </div>
                      )}
                      {serviceSection === 'video' && (
                        <div className="mt-4">
                          <VideoSettings selectedProviderId={selectedVideoProviderId} />
                        </div>
                      )}
                      {serviceSection === 'tts' && (
                        <div className="mt-4">
                          <TTSSettings selectedProviderId={ttsBrowseId ?? ttsProviderId} />
                        </div>
                      )}
                      {serviceSection === 'asr' && (
                        <div className="mt-4">
                          <ASRSettings selectedProviderId={asrBrowseId ?? asrProviderId} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer：所有改动即时保存，这里只保留关闭，避免「保存」按钮
                暗示不点就不生效的误导（面板内的保存按钮是各自独立语义）。 */}
            <div className="flex items-center justify-end gap-3 px-5 py-3 border-t bg-muted/30">
              {saveStatus === 'saved' && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{t('settings.saveSuccess')}</span>
                </div>
              )}
              {saveStatus === 'error' && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <XCircle className="h-4 w-4" />
                  <span>{t('settings.saveFailed')}</span>
                </div>
              )}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('settings.close')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Edit Model Dialog */}
      <ModelEditDialog
        open={showModelDialog}
        onOpenChange={setShowModelDialog}
        editingModel={editingModel}
        setEditingModel={setEditingModel}
        onSave={handleSaveModel}
        onAutoSave={handleAutoSaveModel}
        providerId={selectedProviderId}
        apiKey={providersConfig[selectedProviderId]?.apiKey || ''}
        baseUrl={providersConfig[selectedProviderId]?.baseUrl}
        providerType={providersConfig[selectedProviderId]?.type}
        requiresApiKey={providersConfig[selectedProviderId]?.requiresApiKey}
        isServerConfigured={providersConfig[selectedProviderId]?.isServerConfigured}
      />

      {/* Add Provider Dialog */}
      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        onAdd={handleAddProvider}
      />

      {/* Add TTS Provider Dialog */}
      <AddAudioProviderDialog
        open={showAddTTSProviderDialog}
        onOpenChange={setShowAddTTSProviderDialog}
        onAdd={handleAddTTSProvider}
        type="tts"
      />

      {/* Add ASR Provider Dialog */}
      <AddAudioProviderDialog
        open={showAddASRProviderDialog}
        onOpenChange={setShowAddASRProviderDialog}
        onAdd={handleAddASRProvider}
        type="asr"
      />

      {/* Delete Provider Confirmation */}
      <AlertDialog
        open={providerToDelete !== null}
        onOpenChange={(open) => !open && setProviderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteProviderConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteProvider}>
              {t('settings.deleteProvider')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
