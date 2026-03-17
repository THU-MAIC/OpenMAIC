'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
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
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { toast } from 'sonner';
import { type ProviderId } from '@/lib/ai/providers';
import { PROVIDERS } from '@/lib/ai/providers';
import { cn } from '@/lib/utils';
import { getProviderTypeLabel } from './utils';
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
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { GeneralSettings } from './general-settings';
import { ModelEditDialog } from './model-edit-dialog';
import { AddProviderDialog, type NewProviderData } from './add-provider-dialog';
import type { SettingsSection, EditingModel } from '@/lib/types/settings';

// ─── Provider List Column (reusable) ───
function ProviderListColumn<T extends string>({
  providers,
  configs,
  selectedId,
  onSelect,
  width,
  t,
}: {
  providers: Array<{ id: T; name: string; icon?: string }>;
  configs: Record<string, { isServerConfigured?: boolean }>;
  selectedId: T;
  onSelect: (id: T) => void;
  width: number;
  t: (key: string) => string;
}) {
  return (
    <div className="flex-shrink-0 bg-background flex flex-col" style={{ width }}>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {providers.map((provider) => (
          <button
            key={provider.id}
            onClick={() => onSelect(provider.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all border text-left',
              selectedId === provider.id
                ? 'bg-primary/5 border-primary/50 shadow-sm'
                : 'border-transparent hover:bg-muted/50',
            )}
          >
            {provider.icon ? (
              <img
                src={provider.icon}
                alt={provider.name}
                className="w-5 h-5 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="font-medium text-sm flex-1 truncate">{provider.name}</span>
            {configs[provider.id]?.isServerConfigured && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Helper: get TTS/ASR provider display name ───
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  const names: Record<TTSProviderId, string> = {
    'openai-tts': t('settings.providerOpenAITTS'),
    'azure-tts': t('settings.providerAzureTTS'),
    'glm-tts': t('settings.providerGLMTTS'),
    'qwen-tts': t('settings.providerQwenTTS'),
    'browser-native-tts': t('settings.providerBrowserNativeTTS'),
  };
  return names[providerId];
}

function getASRProviderName(providerId: ASRProviderId, t: (key: string) => string): string {
  const names: Record<ASRProviderId, string> = {
    'openai-whisper': t('settings.providerOpenAIWhisper'),
    'browser-native': t('settings.providerBrowserNative'),
    'qwen-asr': t('settings.providerQwenASR'),
  };
  return names[providerId];
}

// ─── Image/Video provider name helpers ───
const IMAGE_PROVIDER_NAMES: Record<ImageProviderId, string> = {
  seedream: 'providerSeedream',
  'qwen-image': 'providerQwenImage',
  'nano-banana': 'providerNanoBanana',
};

const IMAGE_PROVIDER_ICONS: Record<ImageProviderId, string> = {
  seedream: '/logos/doubao.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
};

const VIDEO_PROVIDER_NAMES: Record<VideoProviderId, string> = {
  seedance: 'providerSeedance',
  kling: 'providerKling',
  veo: 'providerVeo',
  sora: 'providerSora',
};

const VIDEO_PROVIDER_ICONS: Record<VideoProviderId, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  sora: '/logos/openai.svg',
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
  const setModel = useSettingsStore((state) => state.setModel);
  const setProviderConfig = useSettingsStore((state) => state.setProviderConfig);
  const setProvidersConfig = useSettingsStore((state) => state.setProvidersConfig);
  const setTTSProvider = useSettingsStore((state) => state.setTTSProvider);
  const setASRProvider = useSettingsStore((state) => state.setASRProvider);

  // Navigation
  const [activeSection, setActiveSection] = useState<SettingsSection>('providers');
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>(providerId);
  const [selectedPdfProviderId, setSelectedPdfProviderId] = useState<PDFProviderId>(pdfProviderId);
  const [selectedWebSearchProviderId, setSelectedWebSearchProviderId] =
    useState<WebSearchProviderId>(webSearchProviderId);
  const [selectedImageProviderId, setSelectedImageProviderId] =
    useState<ImageProviderId>(imageProviderId);
  const [selectedVideoProviderId, setSelectedVideoProviderId] =
    useState<VideoProviderId>(videoProviderId);
  // Navigate to initialSection when dialog opens
  useEffect(() => {
    if (open && initialSection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync section from prop when dialog opens
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  // Model editing state
  const [editingModel, setEditingModel] = useState<EditingModel | null>(null);
  const [showModelDialog, setShowModelDialog] = useState(false);

  // Provider deletion confirmation
  const [providerToDelete, setProviderToDelete] = useState<ProviderId | null>(null);

  // Add provider dialog
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false);

  // Save status indicator
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // Resizable column widths
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const [providerListWidth, setProviderListWidth] = useState(192);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    target: 'sidebar' | 'providerList';
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, target: 'sidebar' | 'providerList') => {
      e.preventDefault();
      const startWidth = target === 'sidebar' ? sidebarWidth : providerListWidth;
      resizeRef.current = { target, startX: e.clientX, startWidth };
      setIsResizing(true);
    },
    [sidebarWidth, providerListWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { target, startX, startWidth } = resizeRef.current;
      const delta = e.clientX - startX;
      const newWidth = Math.max(120, Math.min(360, startWidth + delta));
      if (target === 'sidebar') {
        setSidebarWidth(newWidth);
      } else {
        setProviderListWidth(newWidth);
      }
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

  const handleSave = () => {
    onOpenChange(false);
  };

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
      [newProviderId]: {
        apiKey: '',
        baseUrl: '',
        models: [],
        name: providerData.name,
        type: providerData.type,
        defaultBaseUrl: providerData.baseUrl || undefined,
        icon: providerData.icon || undefined,
        requiresApiKey: providerData.requiresApiKey,
        isBuiltIn: false,
      },
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
    setProvidersConfig(updatedConfig);
    if (selectedProviderId === pid) {
      const firstRemainingPid = Object.keys(updatedConfig)[0] as ProviderId | undefined;
      setSelectedProviderId(firstRemainingPid || 'openai');
    }
    if (providerId === pid) {
      const firstRemainingPid = Object.keys(updatedConfig)[0] as ProviderId | undefined;
      const firstModel = firstRemainingPid
        ? updatedConfig[firstRemainingPid]?.serverModels?.[0] ||
          updatedConfig[firstRemainingPid]?.models?.[0]?.id
        : undefined;
      if (firstRemainingPid && firstModel) {
        setModel(firstRemainingPid, firstModel);
      } else {
        setModel('openai' as ProviderId, 'gpt-4o-mini');
      }
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
    models: config.models,
    isServerConfigured: config.isServerConfigured,
  }));

  // Sections that show a provider list column
  const _hasProviderList = [
    'providers',
    'pdf',
    'web-search',
    'image',
    'video',
    'tts',
    'asr',
  ].includes(activeSection);

  // Get header content based on section
  const getHeaderContent = () => {
    switch (activeSection) {
      case 'general':
        return <h2 className="text-lg font-semibold">{t('settings.systemSettings')}</h2>;
      case 'providers':
        if (selectedProvider) {
          return (
            <>
              {selectedProvider.icon ? (
                <img
                  src={selectedProvider.icon}
                  alt={selectedProvider.name}
                  className="w-8 h-8 rounded"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <Box className="h-8 w-8 text-muted-foreground" />
              )}
              <div>
                <h2 className="text-lg font-semibold">{selectedProvider.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {getProviderTypeLabel(selectedProvider.type, t)}
                </p>
              </div>
            </>
          );
        }
        return null;
      case 'pdf': {
        const pdfProvider = PDF_PROVIDERS[selectedPdfProviderId];
        return (
          <>
            {pdfProvider.icon ? (
              <img
                src={pdfProvider.icon}
                alt={pdfProvider.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{pdfProvider.name}</h2>
          </>
        );
      }
      case 'web-search': {
        const wsProvider = WEB_SEARCH_PROVIDERS[selectedWebSearchProviderId];
        return (
          <>
            {wsProvider.icon ? (
              <img
                src={wsProvider.icon}
                alt={wsProvider.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{wsProvider.name}</h2>
          </>
        );
      }
      case 'image': {
        const imgProvider = IMAGE_PROVIDERS[selectedImageProviderId];
        const imgIcon = IMAGE_PROVIDER_ICONS[selectedImageProviderId];
        return (
          <>
            {imgIcon ? (
              <img
                src={imgIcon}
                alt={imgProvider?.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {t(`settings.${IMAGE_PROVIDER_NAMES[selectedImageProviderId]}`) || imgProvider?.name}
            </h2>
          </>
        );
      }
      case 'video': {
        const vidProvider = VIDEO_PROVIDERS[selectedVideoProviderId];
        const vidIcon = VIDEO_PROVIDER_ICONS[selectedVideoProviderId];
        return (
          <>
            {vidIcon ? (
              <img
                src={vidIcon}
                alt={vidProvider?.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {t(`settings.${VIDEO_PROVIDER_NAMES[selectedVideoProviderId]}`) || vidProvider?.name}
            </h2>
          </>
        );
      }
      case 'tts': {
        const ttsIcon = TTS_PROVIDERS[ttsProviderId]?.icon;
        return (
          <>
            {ttsIcon ? (
              <img
                src={ttsIcon}
                alt=""
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Volume2 className="h-6 w-6 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{getTTSProviderName(ttsProviderId, t)}</h2>
          </>
        );
      }
      case 'asr': {
        const asrIcon = ASR_PROVIDERS[asrProviderId]?.icon;
        return (
          <>
            {asrIcon ? (
              <img
                src={asrIcon}
                alt=""
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Mic className="h-6 w-6 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{getASRProviderName(asrProviderId, t)}</h2>
          </>
        );
      }
      default:
        return null;
    }
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
              onClick={() => setActiveSection('providers')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'providers'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Box className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.providers')}</span>
            </button>

            <button
              onClick={() => setActiveSection('image')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'image'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <ImageIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.imageSettings')}</span>
            </button>

            <button
              onClick={() => setActiveSection('video')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'video'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Film className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.videoSettings')}</span>
            </button>

            <button
              onClick={() => setActiveSection('tts')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'tts'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Volume2 className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.ttsSettings')}</span>
            </button>

            <button
              onClick={() => setActiveSection('asr')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'asr'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Mic className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.asrSettings')}</span>
            </button>

            <button
              onClick={() => setActiveSection('pdf')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'pdf'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.pdfSettings')}</span>
            </button>

            <button
              onClick={() => setActiveSection('web-search')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'web-search'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.webSearchSettings')}</span>
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
            onMouseDown={(e) => handleResizeStart(e, 'sidebar')}
            className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
          >
            <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Middle - Provider List (only shown for provider-based sections) */}
          {activeSection === 'providers' && (
            <>
              <ProviderList
                providers={allProviders}
                selectedProviderId={selectedProviderId}
                onSelect={handleProviderSelect}
                onAddProvider={() => setShowAddProviderDialog(true)}
                width={providerListWidth}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'pdf' && (
            <>
              <ProviderListColumn
                providers={Object.values(PDF_PROVIDERS)}
                configs={pdfProvidersConfig}
                selectedId={selectedPdfProviderId}
                onSelect={setSelectedPdfProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'web-search' && (
            <>
              <ProviderListColumn
                providers={Object.values(WEB_SEARCH_PROVIDERS)}
                configs={webSearchProvidersConfig}
                selectedId={selectedWebSearchProviderId}
                onSelect={setSelectedWebSearchProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'image' && (
            <>
              <ProviderListColumn
                providers={Object.values(IMAGE_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: t(`settings.${IMAGE_PROVIDER_NAMES[p.id]}`) || p.name,
                  icon: IMAGE_PROVIDER_ICONS[p.id],
                }))}
                configs={imageProvidersConfig}
                selectedId={selectedImageProviderId}
                onSelect={setSelectedImageProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'video' && (
            <>
              <ProviderListColumn
                providers={Object.values(VIDEO_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: t(`settings.${VIDEO_PROVIDER_NAMES[p.id]}`) || p.name,
                  icon: VIDEO_PROVIDER_ICONS[p.id],
                }))}
                configs={videoProvidersConfig}
                selectedId={selectedVideoProviderId}
                onSelect={setSelectedVideoProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'tts' && (
            <>
              <ProviderListColumn
                providers={Object.values(TTS_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: getTTSProviderName(p.id, t),
                  icon: p.icon,
                }))}
                configs={ttsProvidersConfig}
                selectedId={ttsProviderId}
                onSelect={setTTSProvider}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'asr' && (
            <>
              <ProviderListColumn
                providers={Object.values(ASR_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: getASRProviderName(p.id, t),
                  icon: p.icon,
                }))}
                configs={asrProvidersConfig}
                selectedId={asrProviderId}
                onSelect={setASRProvider}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {/* Right - Configuration Panel */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b">
              <div className="flex items-center gap-3">{getHeaderContent()}</div>
              <div className="flex items-center gap-2">
                {activeSection === 'providers' &&
                  !providersConfig[selectedProviderId]?.isBuiltIn && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteProvider(selectedProviderId)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {activeSection === 'general' && <GeneralSettings />}

              {activeSection === 'providers' && selectedProvider && (
                <ProviderConfigPanel
                  provider={selectedProvider}
                  initialApiKey={providersConfig[selectedProviderId]?.apiKey || ''}
                  initialBaseUrl={providersConfig[selectedProviderId]?.baseUrl || ''}
                  initialRequiresApiKey={
                    providersConfig[selectedProviderId]?.requiresApiKey ?? true
                  }
                  providersConfig={providersConfig}
                  onConfigChange={(apiKey, baseUrl, requiresApiKey) =>
                    handleProviderConfigChange(selectedProviderId, apiKey, baseUrl, requiresApiKey)
                  }
                  onSave={handleProviderConfigSave}
                  onEditModel={(index) => handleEditModel(selectedProviderId, index)}
                  onDeleteModel={(index) => handleDeleteModel(selectedProviderId, index)}
                  onAddModel={handleAddModel}
                  onResetToDefault={() => handleResetProvider(selectedProviderId)}
                  isBuiltIn={providersConfig[selectedProviderId]?.isBuiltIn ?? true}
                />
              )}

              {activeSection === 'pdf' && (
                <PDFSettings selectedProviderId={selectedPdfProviderId} />
              )}
              {activeSection === 'web-search' && (
                <WebSearchSettings selectedProviderId={selectedWebSearchProviderId} />
              )}
              {activeSection === 'image' && (
                <ImageSettings selectedProviderId={selectedImageProviderId} />
              )}
              {activeSection === 'video' && (
                <VideoSettings selectedProviderId={selectedVideoProviderId} />
              )}
              {activeSection === 'tts' && <TTSSettings selectedProviderId={ttsProviderId} />}
              {activeSection === 'asr' && <ASRSettings selectedProviderId={asrProviderId} />}
            </div>

            {/* Footer */}
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
              <Button size="sm" onClick={handleSave}>
                {t('settings.save')}
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
      />

      {/* Add Provider Dialog */}
      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        onAdd={handleAddProvider}
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
