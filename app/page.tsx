'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  Bell,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Copy,
  FileText,
  FolderKanban,
  Home,
  ImagePlus,
  MessageSquareText,
  MoreVertical,
  Pencil,
  Search,
  Shield,
  ShoppingBag,
  Sparkles,
  Trash2,
  Settings,
  BotOff,
  ChevronUp,
  Users,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { nanoid } from 'nanoid';
import { storePdfBlob } from '@/lib/utils/image-storage';
import type { UserRequirements } from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  getFirstSlideByStages,
} from '@/lib/utils/stage-storage';
import { ThumbnailSlide } from '@/components/slide-renderer/components/ThumbnailSlide';
import type { Slide } from '@/lib/types/slides';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const LANGUAGE_STORAGE_KEY = 'generationLanguage';

interface FormState {
  pdfFile: File | null;
  requirement: string;
  language: 'zh-CN' | 'en-US';
  webSearch: boolean;
}

interface SidebarItem {
  label: string;
  icon: typeof Home;
  active: boolean;
  inset?: boolean;
}

interface SidebarGroup {
  title: string;
  items: SidebarItem[];
}

const initialFormState: FormState = {
  pdfFile: null,
  requirement: '',
  language: 'zh-CN',
  webSearch: false,
};

const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    title: 'Home',
    items: [{ label: 'Home', icon: Home, active: false }],
  },
  {
    title: 'Pages',
    items: [
      { label: 'Profile', icon: FileText, active: false },
      { label: 'Profile overview', icon: Home, active: false, inset: true },
      { label: 'Teams', icon: Users, active: false, inset: true },
      { label: 'All projects', icon: FolderKanban, active: true, inset: true },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Users', icon: Users, active: false },
      { label: 'Projects', icon: BriefcaseBusiness, active: false },
      { label: 'Notification', icon: Bell, active: false },
      { label: 'Chat', icon: MessageSquareText, active: false },
    ],
  },
  {
    title: 'Admin',
    items: [
      { label: 'Applications', icon: ShoppingBag, active: false },
      { label: 'Authentication', icon: Shield, active: false },
    ],
  },
];

function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialFormState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // Model setup state
  const currentModelId = useSettingsStore((s) => s.modelId);
  const profileAvatar = useUserProfileStore((s) => s.avatar);
  const profileName = useUserProfileStore((s) => s.nickname) || t('profile.defaultNickname');
  const profileBio = useUserProfileStore((s) => s.bio) || 'Interactive classroom builder';
  const [searchQuery, setSearchQuery] = useState('');

  // Hydrate client-only state after mount (avoids SSR mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    try {
      const savedWebSearch = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
      const savedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      const updates: Partial<FormState> = {};
      if (savedWebSearch === 'true') updates.webSearch = true;
      if (savedLanguage === 'zh-CN' || savedLanguage === 'en-US') {
        updates.language = savedLanguage;
      } else {
        const detected = navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
        updates.language = detected;
      }
      if (Object.keys(updates).length > 0) {
        setForm((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Restore requirement draft from cache (derived state pattern — no effect needed)
  const [prevCachedRequirement, setPrevCachedRequirement] = useState(cachedRequirement);
  if (cachedRequirement !== prevCachedRequirement) {
    setPrevCachedRequirement(cachedRequirement);
    if (cachedRequirement) {
      setForm((prev) => ({ ...prev, requirement: cachedRequirement }));
    }
  }

  const [error, setError] = useState<string | null>(null);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadClassrooms = async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      // Load first slide thumbnails
      if (list.length > 0) {
        const slides = await getFirstSlideByStages(list.map((c) => c.id));
        setThumbnails(slides);
      }
    } catch (err) {
      log.error('Failed to load classrooms:', err);
    }
  };

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Store hydration on mount
    loadClassrooms();
  }, []);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'webSearch') localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(value));
      if (field === 'language') localStorage.setItem(LANGUAGE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const showSetupToast = (icon: React.ReactNode, title: string, desc: string) => {
    toast.custom(
      (id) => (
        <div
          className="w-[356px] rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-gradient-to-r from-amber-50 via-white to-amber-50 dark:from-amber-950/60 dark:via-slate-900 dark:to-amber-950/60 shadow-lg shadow-amber-500/8 dark:shadow-amber-900/20 p-4 flex items-start gap-3 cursor-pointer"
          onClick={() => {
            toast.dismiss(id);
            setSettingsOpen(true);
          }}
        >
          <div className="shrink-0 mt-0.5 size-9 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center ring-1 ring-amber-200/50 dark:ring-amber-800/30">
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 leading-tight">
              {title}
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/70 mt-0.5 leading-relaxed">
              {desc}
            </p>
          </div>
          <div className="shrink-0 mt-1 text-[10px] font-medium text-amber-500 dark:text-amber-500/70 tracking-wide">
            <Settings className="size-3.5 animate-[spin_3s_linear_infinite]" />
          </div>
        </div>
      ),
      { duration: 4000 },
    );
  };

  const handleGenerate = async () => {
    // Validate setup before proceeding
    if (!currentModelId) {
      showSetupToast(
        <BotOff className="size-4.5 text-amber-600 dark:text-amber-400" />,
        t('settings.modelNotConfigured'),
        t('settings.setupNeeded'),
      );
      setSettingsOpen(true);
      return;
    }

    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    setError(null);

    try {
      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        requirement: form.requirement,
        language: form.language,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        webSearch: form.webSearch || undefined,
      };

      let pdfStorageKey: string | undefined;
      let pdfFileName: string | undefined;
      let pdfProviderId: string | undefined;
      let pdfProviderConfig: { apiKey?: string; baseUrl?: string } | undefined;

      if (form.pdfFile) {
        pdfStorageKey = await storePdfBlob(form.pdfFile);
        pdfFileName = form.pdfFile.name;

        const settings = useSettingsStore.getState();
        pdfProviderId = settings.pdfProviderId;
        const providerCfg = settings.pdfProvidersConfig?.[settings.pdfProviderId];
        if (providerCfg) {
          pdfProviderConfig = {
            apiKey: providerCfg.apiKey,
            baseUrl: providerCfg.baseUrl,
          };
        }
      }

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        pdfStorageKey,
        pdfFileName,
        pdfProviderId,
        pdfProviderConfig,
        sceneOutlines: null,
        currentStep: 'generating' as const,
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  const canGenerate = !!form.requirement.trim();
  const filteredClassrooms = classrooms.filter((classroom) => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return true;
    return classroom.name.toLowerCase().includes(needle);
  });
  const latestClassroom = classrooms[0];
  const dashboardActions = [
    {
      label: 'Student enroll',
      caption: 'Open agent and roster setup',
      icon: Users,
      onClick: () => {
        setSettingsSection('agents');
        setSettingsOpen(true);
      },
    },
    {
      label: 'Upload content',
      caption: 'Jump straight into source intake',
      icon: FileText,
      onClick: () => textareaRef.current?.focus(),
    },
    {
      label: 'Export data',
      caption: 'Open the latest classroom export lane',
      icon: BriefcaseBusiness,
      onClick: () => {
        if (latestClassroom) {
          router.push(`/classroom/${latestClassroom.id}`);
        } else {
          toast.message('Create a classroom first, then export from the classroom header.');
        }
      },
    },
    {
      label: 'One on one',
      caption: 'Resume the newest classroom session',
      icon: MessageSquareText,
      onClick: () => {
        if (latestClassroom) {
          router.push(`/classroom/${latestClassroom.id}`);
        } else {
          toast.message('Your 1:1 flow starts after the first classroom is generated.');
        }
      },
    },
  ] as const;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate) handleGenerate();
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#f5f6fb] text-slate-950 dark:bg-slate-950 dark:text-slate-100">
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[218px] shrink-0 border-r border-slate-200/80 bg-white/96 px-3 py-6 dark:border-slate-800 dark:bg-slate-900/95 lg:flex lg:flex-col">
          <div className="px-4 pb-8 pt-2">
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-11 w-auto" />
          </div>

          <div className="flex-1 space-y-7 overflow-y-auto pr-1">
            {SIDEBAR_GROUPS.map((group) => (
              <div key={group.title} className="space-y-3">
                <div
                  className={cn(
                    'flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium',
                    group.title === 'Pages'
                      ? 'bg-[#d9c7ff] text-[#5f2bd8]'
                      : 'text-slate-700 dark:text-slate-300',
                  )}
                >
                  <span className="flex items-center gap-3">
                    <FolderKanban className="size-4" />
                    {group.title}
                  </span>
                  <ChevronDown className="size-4" />
                </div>
                <div className="space-y-1 px-2">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.label}
                        className={cn(
                          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition-colors',
                          item.inset && 'ml-6',
                          item.active
                            ? 'text-[#6c39de]'
                            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70',
                        )}
                      >
                        <Icon className={cn('size-4', item.active && 'text-[#6c39de]')} />
                        <span>{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <GreetingBar />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="px-5 pb-8 pt-7 sm:px-8 lg:px-10">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[18px] font-semibold tracking-[-0.03em] text-[#6c39de] sm:text-[20px]">
                  Profile/All projects
                </p>
              </div>
              <label className="flex h-12 w-full max-w-[330px] items-center gap-3 rounded-full border border-slate-200 bg-white px-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                <Search className="size-4 text-slate-400" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search anything here..."
                  className="w-full border-0 bg-transparent text-sm text-slate-600 outline-none placeholder:text-slate-400 dark:text-slate-200"
                />
              </label>
            </div>

            <motion.section
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
              className="mt-6 rounded-[20px] border border-slate-200 bg-white p-5 shadow-[0_16px_48px_rgba(15,23,42,0.05)] dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={profileAvatar}
                    alt=""
                    className="size-10 rounded-full border border-slate-200 object-cover dark:border-slate-700"
                  />
                  <div>
                    <p className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
                      {profileName}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{profileBio}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button className="rounded-md bg-[#6c39de] px-7 py-2 text-sm font-medium text-white shadow-sm">
                    App
                  </button>
                  <button className="rounded-md border border-[#b999ff] px-7 py-2 text-sm font-medium text-[#6c39de]">
                    Messages
                  </button>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="rounded-md border border-[#b999ff] px-7 py-2 text-sm font-medium text-[#6c39de]"
                  >
                    Settings
                  </button>
                </div>
              </div>

              <div className="mt-5 rounded-[16px] border border-slate-100 bg-[#fafaff] p-4 shadow-inner dark:border-slate-800 dark:bg-slate-950/60">
                <div className="flex flex-col gap-4 rounded-[14px] bg-[#f3f1ff] p-5 dark:bg-slate-900/80">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-[15px] font-medium text-slate-900 dark:text-slate-100">
                        Some of Our Awesome classrooms
                      </p>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        Swap the kit demo data for real OpenMAIC classrooms and launch the next one
                        from here.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Sparkles className="size-4 text-[#6c39de]" />
                      {filteredClassrooms.length} active spaces
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {dashboardActions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.label}
                          onClick={action.onClick}
                          className="flex items-start gap-3 rounded-[16px] border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[#c5b1ff] dark:border-slate-800 dark:bg-slate-900"
                        >
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[#f1ebff] text-[#6c39de]">
                            <Icon className="size-4" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {action.label}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                              {action.caption}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="rounded-[18px] border border-white/90 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <img src="/logo-horizontal.png" alt="" aria-hidden="true" className="h-8 w-auto" />
                        <p className="mt-4 text-[18px] font-semibold text-slate-900 dark:text-slate-100">
                          Create a new classroom
                        </p>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                          Keep the dashboard light, but wire it to the real generation flow.
                        </p>
                      </div>
                      <div className="hidden pt-1 lg:block">
                        <AgentBar />
                      </div>
                    </div>

                    <div className="mt-4 overflow-hidden rounded-[16px] border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/80">
                      <textarea
                        ref={textareaRef}
                        placeholder={t('upload.requirementPlaceholder')}
                        className="min-h-[128px] w-full resize-none border-0 bg-transparent px-4 py-4 text-[13px] leading-relaxed text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-200"
                        value={form.requirement}
                        onChange={(e) => updateForm('requirement', e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={4}
                      />
                      <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3 dark:border-slate-800 xl:flex-row xl:items-end">
                        <div className="min-w-0 flex-1">
                          <GenerationToolbar
                            language={form.language}
                            onLanguageChange={(lang) => updateForm('language', lang)}
                            webSearch={form.webSearch}
                            onWebSearchChange={(v) => updateForm('webSearch', v)}
                            onSettingsOpen={(section) => {
                              setSettingsSection(section);
                              setSettingsOpen(true);
                            }}
                            pdfFile={form.pdfFile}
                            onPdfFileChange={(f) => updateForm('pdfFile', f)}
                            onPdfError={setError}
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <SpeechButton
                            size="md"
                            onTranscription={(text) => {
                              setForm((prev) => {
                                const next = prev.requirement + (prev.requirement ? ' ' : '') + text;
                                updateRequirementCache(next);
                                return { ...prev, requirement: next };
                              });
                            }}
                          />
                          <button
                            onClick={handleGenerate}
                            disabled={!canGenerate}
                            className={cn(
                              'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-all',
                              canGenerate
                                ? 'bg-[#6c39de] text-white shadow-sm hover:bg-[#5f2bd8]'
                                : 'bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                            )}
                          >
                            {t('toolbar.enterClassroom')}
                            <ArrowUp className="size-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <AnimatePresence>
                      {error && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="mt-3 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3"
                        >
                          <p className="text-sm text-destructive">{error}</p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="mt-5 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {filteredClassrooms.map((classroom) => (
                    <ClassroomCard
                      key={classroom.id}
                      classroom={classroom}
                      slide={thumbnails[classroom.id]}
                      formatDate={formatDate}
                      onDelete={handleDelete}
                      confirmingDelete={pendingDeleteId === classroom.id}
                      onConfirmDelete={() => confirmDelete(classroom.id)}
                      onCancelDelete={() => setPendingDeleteId(null)}
                      onClick={() => router.push(`/classroom/${classroom.id}`)}
                    />
                  ))}
                  {filteredClassrooms.length === 0 && (
                    <div className="col-span-full rounded-[18px] border border-dashed border-slate-300 bg-white px-6 py-16 text-center dark:border-slate-700 dark:bg-slate-900">
                      <p className="text-base font-medium text-slate-700 dark:text-slate-200">
                        No classrooms match that search yet.
                      </p>
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        Try another title or create a fresh classroom from the composer above.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.section>
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = nickname || t('profile.defaultNickname');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ── */}
      {!open && (
        <div
          className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full px-2.5 py-1.5 border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-violet-400/60 dark:group-hover:ring-violet-400/40 transition-all duration-300">
              <img src={avatar} alt="" className="size-full object-cover" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
              <Pencil className="size-[7px] text-muted-foreground/70" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="leading-none select-none flex items-center gap-1">
                  <span>
                    <span className="text-xs text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
                      {t('home.greeting')}
                    </span>
                    <span className="text-[13px] font-semibold text-foreground/85 group-hover:text-foreground transition-colors">
                      {displayName}
                    </span>
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('profile.editTooltip')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => {
                  setOpen(false);
                  setEditingName(false);
                  setAvatarPickerOpen(false);
                }}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 relative cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-violet-300/70 dark:ring-violet-500/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/60 flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-muted-foreground/70 transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                          if (e.key === 'Escape') {
                            setEditingName(false);
                          }
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
                      />
                      <button
                        onClick={commitName}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[13px] font-semibold text-foreground/85 group-hover/name:text-foreground transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                    </span>
                  )}
                </div>

                {/* Collapse arrow */}
                <motion.div
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-muted-foreground/50" />
                </motion.div>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url) => (
                          <button
                            key={url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-gray-50 dark:bg-gray-800 cursor-pointer transition-all duration-150',
                              'hover:scale-110 active:scale-95',
                              avatar === url
                                ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            'hover:scale-110 active:scale-95',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0 border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30'
                              : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                          )}
                          onClick={() => avatarInputRef.current?.click()}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Classroom Card — clean, minimal style ──────────────────────
function ClassroomCard({
  classroom,
  slide,
  formatDate,
  onDelete,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  formatDate: (ts: number) => string;
  onDelete: (id: string, e: React.MouseEvent) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const classroomInitials = classroom.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className="group relative rounded-[18px] border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-[#c5b1ff] dark:border-slate-800 dark:bg-slate-900"
      onClick={confirmingDelete ? undefined : onClick}
    >
      <div
        ref={thumbRef}
        className="relative mb-4 h-[184px] overflow-hidden rounded-[14px] border border-slate-100 bg-white dark:border-slate-800 dark:bg-slate-950"
      >
        {slide && thumbWidth > 0 ? (
          <ThumbnailSlide
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : !slide ? (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#fff1f5] via-white to-[#f2eeff] dark:from-slate-900 dark:via-slate-950 dark:to-slate-900">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-[#ffdfe9] text-sm font-semibold uppercase tracking-[0.18em] text-[#ff5c8a]">
              {classroomInitials || 'CL'}
            </div>
          </div>
        ) : null}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white/92 via-white/35 to-transparent dark:from-slate-950/92" />

        <AnimatePresence>
          {!confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-2 top-2 size-8 rounded-full border border-white/80 bg-white/90 text-slate-500 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive dark:border-slate-700 dark:bg-slate-900/90"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <MoreVertical className="size-4" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/60 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[13px] font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[#ffe5ee] text-xs font-semibold uppercase tracking-[0.18em] text-[#ff5c8a]">
          {classroomInitials || 'CL'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="truncate text-[18px] font-medium tracking-[-0.02em] text-slate-900 dark:text-slate-100">
                  {classroom.name}
                </p>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={4}
                className="!max-w-[min(90vw,32rem)] break-words whitespace-normal"
              >
                <div className="flex items-center gap-1.5">
                  <span className="break-all">{classroom.name}</span>
                  <button
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(classroom.name);
                      toast.success(t('classroom.nameCopied'));
                    }}
                  >
                    <Copy className="size-3 opacity-60" />
                  </button>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="mt-2 flex -space-x-1.5">
            {AVATAR_OPTIONS.slice(0, 4).map((avatar, index) => (
              <img
                key={`${classroom.id}-${avatar}-${index}`}
                src={avatar}
                alt=""
                className="size-5 rounded-full border border-white object-cover dark:border-slate-900"
              />
            ))}
          </div>

          <p className="mt-3 min-h-[44px] text-[13px] leading-5 text-slate-500 dark:text-slate-400">
            {classroom.sceneCount} {t('classroom.slides')} ready for presentation, discussion, and
            interactive simulation flow.
          </p>

          <div className="mt-4 border-t border-slate-200 pt-3 text-[12px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[18px] leading-none text-slate-800 dark:text-slate-100">
                  {classroom.sceneCount}
                </p>
                <p className="mt-1">{t('classroom.slides')}</p>
              </div>
              <div className="text-right">
                <p className="text-[15px] leading-none text-slate-800 dark:text-slate-100">
                  {formatDate(classroom.updatedAt)}
                </p>
                <p className="mt-1">Updated</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <HomePage />;
}
