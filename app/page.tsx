'use client';

import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Folder,
  FolderPlus,
  ImagePlus,
  Pencil,
  Trash2,
  Search,
  Settings,
  Sun,
  Moon,
  Monitor,
  ChevronUp,
  Upload,
  Sparkles,
  Atom,
  BookOpen,
  X,
  Presentation,
  Loader2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LanguageSwitcher } from '@/components/language-switcher';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import { deleteDocumentBlob, storeDocumentBlob } from '@/lib/utils/image-storage';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import {
  courseMaterialFingerprint,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import type {
  SelectedCourseMaterial,
  SessionDocumentSource,
  UserRequirements,
} from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  getFirstSlideByStages,
  revokeThumbnailSlideMediaUrls,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setStageFolder,
  FolderNameError,
  type DeleteFolderMode,
} from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/utils/database';
import { displayNameWidth, FOLDER_NAME_MAX_WIDTH } from '@/lib/utils/folder-name-validation';
import { FolderCard } from '@/components/discovery/folder-card';
import { NewFolderDialog } from '@/components/discovery/folder-dialogs';
import { MoveToFolderMenu } from '@/components/discovery/move-to-folder-menu';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import {
  isProWorkbenchEnabled,
  isPptxImportEnabled,
  shouldShowVocationalTestUi,
} from '@/lib/config/feature-flags';
import { useImportPptx } from '@/lib/import/use-import-pptx';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';
import { ProBadge } from '@/components/workbench/ProBadge';
import { arrivedByProSwap, startProSwap } from '@/lib/workbench/pro-swap';
import {
  readLastWorkspaceSessionId,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';
import { useBrand } from '@/lib/brand/brand-context';
import { TaskCreateFields } from '@/components/learning/task-create-fields';
import { buildConceptLearningRequirement } from '@/lib/learning/requirement-adapter';
import {
  LEARNING_TASK_DRAFT_SESSION_KEY,
  getLearningTask,
  upsertLearningTask,
  updateLearningTask,
} from '@/lib/learning/task-storage';
import {
  createConceptLearningTask,
  validateConceptLearningTaskInput,
} from '@/lib/learning/task-template';
import type { ConceptLearningTaskInput } from '@/lib/learning/types';
import { RecentTaskList } from '@/components/learning/recent-task-list';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

// PPTX import is still scaffolding: `useImportPptx` has no `onImported` consumer
// yet, so the flow only logs the parsed slides. Hide the entry point behind a
// flag until it's wired end-to-end, so the UI doesn't expose a no-op button.
const PPTX_IMPORT_ENABLED = isPptxImportEnabled();

/** The configured runtime probe result, retained across client navigations. */
let workbenchRuntimeCache: boolean | null = null;

interface FormState {
  courseMaterials: SelectedCourseMaterial[];
  requirement: string;
  webSearch: boolean;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

const initialFormState: FormState = {
  courseMaterials: [],
  requirement: '',
  webSearch: false,
  interactiveMode: false,
  vocationalTestMode: false,
};

export function HomePage({
  experience = 'dashboard',
}: {
  experience?: 'dashboard' | 'create' | 'learning';
}) {
  const { t, locale } = useI18n();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const brand = useBrand();
  const router = useRouter();
  const isDashboardExperience = experience === 'dashboard';
  const isCreateExperience = experience === 'create';
  const isLearningExperience = experience === 'learning';
  // Do not replay the classic hero's entrance after the route handoff already
  // carried the lockup and composer into place.
  const [swapped] = useState(arrivedByProSwap);
  const heroEnter = (from: Record<string, number>) => (swapped ? false : from);
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const workbenchBuildEnabled = isProWorkbenchEnabled();
  const [workbenchRuntimeEnabled, setWorkbenchRuntimeEnabled] = useState(
    workbenchRuntimeCache === true,
  );
  useEffect(() => {
    if (!workbenchBuildEnabled || workbenchRuntimeCache !== null) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        workbenchRuntimeCache = body?.enabled === true;
        if (!cancelled) setWorkbenchRuntimeEnabled(workbenchRuntimeCache);
      })
      .catch(() => {
        // A failed probe keeps the entry hidden and allows a later visit to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [workbenchBuildEnabled]);
  const workbenchEntryEnabled = workbenchBuildEnabled && workbenchRuntimeEnabled;
  const enterWorkbench = () => {
    const href = workspaceResumeHref(readLastWorkspaceSessionId());
    startProSwap(href, (next) => router.push(next));
  };
  useEffect(() => {
    if (workbenchEntryEnabled) router.prefetch('/workspace');
  }, [router, workbenchEntryEnabled]);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [learningInput, setLearningInput] = useState<ConceptLearningTaskInput>({
    courseName: '',
    knowledgePoint: '',
    learningGoal: '',
    priorKnowledge: '',
  });
  const [learningErrors, setLearningErrors] = useState<
    Partial<Record<keyof ConceptLearningTaskInput, string>>
  >({});
  const [activeLearningTaskId, setActiveLearningTaskId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  const [recentOpen, setRecentOpen] = useState(true);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
      if (saved !== null) setRecentOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedWebSearch = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      const updates: Partial<FormState> = {};
      if (savedWebSearch === 'true') updates.webSearch = true;
      if (savedInteractiveMode === 'true') updates.interactiveMode = true;
      if (Object.keys(updates).length > 0) {
        setForm((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (isLearningExperience) return;
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement, isLearningExperience]);

  useEffect(() => {
    if (!isLearningExperience) return;
    const hasAnyValue = Object.values(learningInput).some((value) => value?.trim());
    setForm((previous) => ({
      ...previous,
      requirement: hasAnyValue ? buildConceptLearningRequirement(learningInput, locale) : '',
    }));
  }, [isLearningExperience, learningInput, locale]);

  useEffect(() => {
    if (!isLearningExperience) return;
    try {
      const taskId = sessionStorage.getItem(LEARNING_TASK_DRAFT_SESSION_KEY);
      if (!taskId) return;
      sessionStorage.removeItem(LEARNING_TASK_DRAFT_SESSION_KEY);
      const task = getLearningTask(taskId);
      if (!task || task.classroomId) return;
      setActiveLearningTaskId(task.id);
      setLearningInput({
        courseName: task.courseName,
        knowledgePoint: task.knowledgePoint,
        learningGoal: task.learningGoal,
        priorKnowledge: task.priorKnowledge,
      });
    } catch {
      // Session storage is optional; the task remains available in local storage.
    }
  }, [isLearningExperience]);

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the Generate click drains upload-time ingests and builds the
  // generation session. Doubles as the guard flag that freezes the course
  // material set for the duration of prep and as the switch that disables the
  // toolbar's add/remove affordances, so the session is always built from a
  // set that cannot change under it.
  const [preparingGenerate, setPreparingGenerate] = useState(false);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Course folders — device-local grouping. `currentFolderId === undefined`
  // is the root view (folders + unfiled courses); a folder id navigates into
  // that folder's course list. Searching flattens every course regardless of
  // folder and annotates each with its folder name.
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // True once the initial classroom + folder loads resolve. Guards layout
  // selection so the hero does not flip between full-screen and compact as the
  // two async reads land (avoids a visible layout shift on first paint).
  const [hydrated, setHydrated] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // When set, the new-folder dialog is creating a folder AND moving this course
  // into it (entered via the move-menu's "new folder" entry).
  const [createAndMoveTarget, setCreateAndMoveTarget] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!isCreateExperience || isLearningExperience) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isCreateExperience, isLearningExperience]);
  const thumbnailsRef = useRef<Record<string, Slide>>({});

  const replaceThumbnails = (slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!themeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeOpen]);

  const loadClassrooms = async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      // Load first slide thumbnails
      if (list.length > 0) {
        const slides = await getFirstSlideByStages(list.map((c) => c.id));
        replaceThumbnails(slides);
      } else {
        replaceThumbnails({});
      }
    } catch (err) {
      log.error('Failed to load classrooms:', err);
      toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
    }
  };

  const loadFolders = async () => {
    try {
      setFolders(await listFolders());
    } catch (err) {
      log.error('Failed to load folders:', err);
    }
  };

  // Capture the active folder when an import starts so the imported course
  // lands in that folder, not whichever folder is active when the async import
  // resolves (the user may have navigated away in the meantime).
  const importFolderRef = useRef<string | undefined>(undefined);
  const handleImportSuccess = async (importedStageId: string) => {
    const folderId = importFolderRef.current;
    importFolderRef.current = undefined;
    // File the imported course into the folder that was active when the
    // import began, before refreshing the list so the card appears in place.
    if (folderId) {
      try {
        await setStageFolder(importedStageId, folderId);
      } catch (err) {
        log.error('Failed to assign imported course to folder:', err);
        toast.error(t('classroom.moveFailed'));
      }
    }
    await loadClassrooms();
  };
  const { importing, fileInputRef, triggerFileSelect, handleFileChange } =
    useImportClassroom(handleImportSuccess);
  const triggerImport = () => {
    importFolderRef.current = currentFolderId;
    triggerFileSelect();
  };

  const {
    importing: pptxImporting,
    fileInputRef: pptxFileInputRef,
    triggerFileSelect: triggerPptxFileSelect,
    handleFileChange: handlePptxFileChange,
  } = useImportPptx();

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Read sessionStorage on the client only (avoids SSR hydration mismatch).
    // Both reads resolve before flipping `hydrated`, so the hero layout does
    // not thrash as each lands independently.
    void Promise.all([loadClassrooms(), loadFolders()]).finally(() => setHydrated(true));

    return () => {
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
    };
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
      toast.success(locale === 'zh-CN' ? '课程已删除' : 'Course deleted');
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error(locale === 'zh-CN' ? '删除课程失败' : 'Failed to delete course');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
      toast.success(locale === 'zh-CN' ? '课程名称已更新' : 'Course name updated');
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  // ─── Folder handlers ────────────────────────────────────────────────
  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name);
    setFolders((prev) => [...prev, folder]);
    // If this create came from the move-menu's "new folder" entry, move the
    // requesting course into the freshly created folder.
    if (createAndMoveTarget) {
      await handleMoveCourse(createAndMoveTarget, folder.id);
      setCreateAndMoveTarget(null);
    }
  };

  const handleRenameFolder =
    (folder: FolderRecord) =>
    async (newName: string): Promise<string | null> => {
      // Empty or unchanged input just exits editing without an error.
      const trimmed = newName.trim();
      if (!trimmed || trimmed === folder.name) return null;
      try {
        await renameFolder(folder.id, newName);
        setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: trimmed } : f)));
        toast.success(locale === 'zh-CN' ? '文件夹名称已更新' : 'Folder name updated');
        return null;
      } catch (err) {
        if (err instanceof FolderNameError) {
          if (err.kind === 'duplicate') return t('classroom.folderNameExists');
          if (err.kind === 'tooLong')
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          return t('classroom.folderNameHint');
        }
        log.error('Failed to rename folder:', err);
        return t('classroom.folderRenameFailed');
      }
    };

  const confirmDeleteFolder = async (folder: FolderRecord, mode: DeleteFolderMode) => {
    try {
      await deleteFolder(folder.id, mode);
      if (currentFolderId === folder.id) setCurrentFolderId(undefined);
      toast.success(
        locale === 'zh-CN'
          ? mode === 'ungroup'
            ? '文件夹已删除，课程已保留'
            : '文件夹及其中课程已删除'
          : mode === 'ungroup'
            ? 'Folder deleted and courses kept'
            : 'Folder and its courses deleted',
      );
    } catch (err) {
      log.error('Failed to delete folder:', err);
      toast.error(t('classroom.folderDeleteFailed'));
    } finally {
      // Always refresh authoritative state: in 'remove' mode a partial failure
      // may have durably deleted some courses before throwing, and the UI must
      // reflect that rather than leaving stale cards/counts behind.
      await Promise.all([loadFolders(), loadClassrooms()]);
    }
  };

  const handleMoveCourse = async (stageId: string, folderId: string | undefined) => {
    // Optimistic update for snappy UI; the persistence call follows.
    setClassrooms((prev) => prev.map((c) => (c.id === stageId ? { ...c, folderId } : c)));
    try {
      await setStageFolder(stageId, folderId);
      toast.success(
        locale === 'zh-CN'
          ? folderId
            ? '课程已移入文件夹'
            : '课程已移至我的课程'
          : folderId
            ? 'Course moved to folder'
            : 'Course moved to My Courses',
      );
    } catch (err) {
      log.error('Failed to move course:', err);
      toast.error(t('classroom.moveFailed'));
      // Revert on failure.
      await loadClassrooms();
    }
  };

  // From the move-menu's "new folder" entry: remember the course, then open the
  // folder dialog. The actual create+move happens in handleCreateFolder once the
  // name is confirmed. (A Radix DropdownMenu is modal, so the name input cannot
  // live inside it; the dialog is the focus surface.)
  const handleCreateAndMove = (stageId: string) => () => {
    setCreateAndMoveTarget(stageId);
    setNewFolderOpen(true);
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return classrooms;
    return classrooms.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [classrooms, deferredSearchQuery]);

  // Folder-aware view model. Searching collapses the hierarchy: every matching
  // course is shown flat, annotated with its folder name. Otherwise the root
  // view shows folder tiles + unfiled courses, and a folder view shows only
  // that folder's members.
  const folderNameById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const isSearching = deferredSearchQuery.trim().length > 0;
  // The course tiles rendered in the active view: search flattens everything;
  // a folder shows only its members; the root shows unfiled courses (folder
  // tiles are rendered separately above them).
  const visibleClassrooms = useMemo(() => {
    if (isSearching) return filteredClassrooms;
    if (currentFolderId) return filteredClassrooms.filter((c) => c.folderId === currentFolderId);
    return filteredClassrooms.filter(
      (c) => c.folderId === undefined || !folderNameById.has(c.folderId),
    );
  }, [filteredClassrooms, isSearching, currentFolderId, folderNameById]);
  const currentFolderClassrooms = useMemo(
    () => (currentFolderId ? classrooms.filter((c) => c.folderId === currentFolderId) : []),
    [classrooms, currentFolderId],
  );
  const courseCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of classrooms) {
      if (c.folderId) counts.set(c.folderId, (counts.get(c.folderId) ?? 0) + 1);
    }
    return counts;
  }, [classrooms]);
  // Up to 3 member course covers (first-slide thumbnails) per folder, for the
  // folder tile's cover stack. Members are ordered by updatedAt desc so the
  // frontmost cover is the most recently touched course.
  const coverSlidesByFolder = useMemo(() => {
    const byFolder = new Map<string, Slide[]>();
    for (const c of [...classrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.folderId) continue;
      const slide = thumbnails[c.id];
      if (!slide) continue;
      const list = byFolder.get(c.folderId) ?? [];
      if (list.length < 3) list.push(slide);
      byFolder.set(c.folderId, list);
    }
    return byFolder;
  }, [classrooms, thumbnails]);
  const currentFolder = folders.find((f) => f.id === currentFolderId);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'webSearch') localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(value));
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const addCourseMaterials = (files: File[]) => {
    // The set is frozen for the duration of generate-prep: adding is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip into the set mid-prep.
    if (preparingGenerate) return;
    const dedupedFiles = dedupeCourseMaterialFiles(form.courseMaterials, files);
    const startOrder = form.courseMaterials.length + 1;
    const additions = dedupedFiles.map((file, index) => ({
      id: nanoid(8),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      order: startOrder + index,
    }));

    if (additions.length === 0) return;
    setForm((prev) => {
      // Pure updater: drop any addition the latest state already carries — by
      // id (a replayed or superseded update) or by content fingerprint (two
      // addCourseMaterials calls in one render batch both dedupe against the
      // same stale closure list, so the same file could otherwise enter twice
      // under two ids and ingest/extract twice) — then append the rest.
      const missing = additions.filter((addition) => {
        if (prev.courseMaterials.some((item) => item.id === addition.id)) return false;
        return !prev.courseMaterials.some(
          (item) => courseMaterialFingerprint(item) === courseMaterialFingerprint(addition),
        );
      });
      if (missing.length === 0) return prev;
      return { ...prev, courseMaterials: [...prev.courseMaterials, ...missing] };
    });
  };

  const removeCourseMaterial = (id: string) => {
    // The set is frozen for the duration of generate-prep: removing is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip out of the set mid-prep.
    if (preparingGenerate) return;
    setForm((prev) => ({
      ...prev,
      courseMaterials: prev.courseMaterials
        .filter((item) => item.id !== id)
        .map((item, index) => ({ ...item, order: index + 1 })),
    }));
  };

  const handleGenerate = async () => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (preparingGenerate) return;
    const nextLearningErrors = isLearningExperience
      ? validateConceptLearningTaskInput(learningInput)
      : {};
    if (Object.keys(nextLearningErrors).length > 0) {
      setLearningErrors(nextLearningErrors);
      setError(
        locale === 'zh-CN' ? '请先补全学习任务的必填信息' : 'Complete the required task fields',
      );
      return;
    }
    setLearningErrors({});

    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    setError(null);

    // The material list and the extractor provider config are frozen for the
    // duration of prep: `preparingGenerate` makes add/remove inert and
    // disables the toolbar affordances (including the extractor Select and the
    // web-search toggle), so neither can change under the session build below.
    // Capture both at click time and build the session from this snapshot,
    // never from live form state or live store state.
    const frozenMaterials = [...form.courseMaterials].sort((a, b) => a.order - b.order);
    const settingsSnapshot = useSettingsStore.getState();
    const frozenPdfProviderId = settingsSnapshot.pdfProviderId;
    const frozenPdfProviderConfig = settingsSnapshot.pdfProvidersConfig?.[
      settingsSnapshot.pdfProviderId
    ]
      ? {
          apiKey: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].apiKey,
          baseUrl: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].baseUrl,
          accessKeyId:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeyId,
          accessKeySecret:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeySecret,
        }
      : undefined;

    // Flip the generating UI state before material bytes are copied locally.
    setPreparingGenerate(true);
    let learningTaskId: string | undefined;
    try {
      if (isLearningExperience) {
        const task = activeLearningTaskId
          ? updateLearningTask(activeLearningTaskId, {
              ...learningInput,
              priorKnowledge: learningInput.priorKnowledge ?? '',
              status: 'generating',
            })
          : createConceptLearningTask(learningInput);
        learningTaskId = task?.id;
        const saved = task
          ? activeLearningTaskId
            ? true
            : upsertLearningTask({ ...task, status: 'generating' })
          : false;
        if (!learningTaskId || !saved) {
          throw new Error(
            locale === 'zh-CN'
              ? '无法在当前浏览器中保存学习任务，请检查存储权限'
              : 'Unable to save the learning task in this browser',
          );
        }
      }
      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        requirement: form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        webSearch: form.webSearch || undefined,
        interactiveMode: form.vocationalTestMode ? true : form.interactiveMode,
        ...(form.vocationalTestMode ? { taskEngineMode: true } : {}),
      };

      let documentSources: SessionDocumentSource[] | undefined;
      let pdfProviderId: string | undefined;
      let pdfProviderConfig:
        | { apiKey?: string; baseUrl?: string; accessKeyId?: string; accessKeySecret?: string }
        | undefined;

      if (frozenMaterials.length > 0) {
        // The session is built from the click-time snapshot (frozen above),
        // never from live store state.
        pdfProviderId = frozenPdfProviderId;
        pdfProviderConfig = frozenPdfProviderConfig;

        const storedDocumentKeys: string[] = [];
        try {
          documentSources = [];
          for (const [index, item] of frozenMaterials.entries()) {
            const storageKey = await storeDocumentBlob(item.file);
            storedDocumentKeys.push(storageKey);
            documentSources.push({
              id: item.id,
              name: item.name,
              size: item.size,
              lastModified: item.lastModified,
              mimeType: normalizeDocumentMimeType({
                mimeType: item.file.type,
                fileName: item.file.name,
              }),
              order: index + 1,
              storageKey,
              providerId: pdfProviderId,
            });
          }
        } catch (error) {
          await Promise.allSettled(storedDocumentKeys.map((key) => deleteDocumentBlob(key)));
          throw error;
        }
      }

      const sessionState = {
        sessionId: nanoid(),
        learningTaskId,
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        documentSources,
        // Backward-compatible single-document fields for previously saved sessions.
        pdfStorageKey: documentSources?.[0]?.storageKey,
        pdfFileName: documentSources?.[0]?.name,
        documentMimeType: documentSources?.[0]?.mimeType,
        pdfProviderId,
        pdfProviderConfig,
        sceneOutlines: null,
        currentStep: 'generating' as const,
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      if (learningTaskId) updateLearningTask(learningTaskId, { status: 'draft' });
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    } finally {
      // Unfreeze the set once prep settles (navigation unmounts this page, so
      // this is normally a no-op on the way out).
      setPreparingGenerate(false);
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

  const learningInputComplete =
    !!learningInput.courseName.trim() &&
    !!learningInput.knowledgePoint.trim() &&
    !!learningInput.learningGoal.trim();
  const canGenerate =
    !!form.requirement.trim() &&
    hasUsableProvider &&
    (!isLearningExperience || learningInputComplete);
  const latestClassroom = useMemo(
    () => [...classrooms].sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [classrooms],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate && !preparingGenerate) handleGenerate();
    }
  };

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center overflow-x-hidden bg-background pb-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
        className="hidden"
      />
      {PPTX_IMPORT_ENABLED && (
        <input
          ref={pptxFileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onChange={handlePptxFileChange}
          className="hidden"
        />
      )}
      {/* ═══ Product navigation ═══ */}
      <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-7">
            <div className="relative shrink-0" data-pro-morph="lockup">
              <button
                type="button"
                onClick={() => router.push('/')}
                aria-label={locale === 'zh-CN' ? '返回我的课程' : 'Back to my courses'}
                className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <img
                  data-testid="home-brand-logo"
                  src={resolvedTheme === 'dark' ? brand.darkLogoSrc : brand.logoSrc}
                  alt={brand.productName}
                  className="h-8 w-auto"
                />
              </button>
              {workbenchEntryEnabled ? (
                <div className="absolute left-full top-0 ml-1" data-pro-morph="badge">
                  <ProBadge active={false} onToggle={enterWorkbench} />
                </div>
              ) : null}
            </div>
            <nav className="hidden items-center gap-1 text-sm md:flex" aria-label="Primary">
              <button
                type="button"
                data-testid="nav-my-courses"
                aria-current={experience === 'dashboard' ? 'page' : undefined}
                onClick={() => router.push('/')}
                className={cn(
                  'rounded-lg px-3 py-2 transition-colors',
                  experience === 'dashboard'
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t('classroom.recentClassrooms')}
              </button>
              <button
                type="button"
                data-testid="nav-learning-task"
                aria-current={isLearningExperience ? 'page' : undefined}
                onClick={() => {
                  if (!isLearningExperience) router.push('/learn/new');
                }}
                className={cn(
                  'rounded-lg px-3 py-2 transition-colors',
                  isLearningExperience
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {locale === 'zh-CN' ? '学习任务' : 'Learning task'}
              </button>
              <button
                type="button"
                data-testid="nav-create-course"
                aria-current={isCreateExperience ? 'page' : undefined}
                onClick={() => {
                  if (isCreateExperience) textareaRef.current?.focus();
                  else router.push('/create');
                }}
                className={cn(
                  'rounded-lg px-3 py-2 transition-colors',
                  isCreateExperience
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t('home.createEyebrow')}
              </button>
            </nav>
          </div>

          <div ref={toolbarRef} className="flex items-center gap-1">
            {/* Language Selector */}
            <LanguageSwitcher onOpen={() => setThemeOpen(false)} />

            <div className="w-[1px] h-4 bg-border" />

            {/* Theme Selector */}
            <div className="relative">
              <button
                onClick={() => {
                  setThemeOpen(!themeOpen);
                }}
                className="rounded-xl p-2 text-muted-foreground transition-all hover:bg-accent hover:text-primary hover:shadow-sm"
              >
                {theme === 'light' && <Sun className="w-4 h-4" />}
                {theme === 'dark' && <Moon className="w-4 h-4" />}
                {theme === 'system' && <Monitor className="w-4 h-4" />}
              </button>
              {themeOpen && (
                <div className="absolute top-full right-0 z-50 mt-2 min-w-[148px] overflow-hidden rounded-xl border border-primary/15 bg-popover/95 p-1.5 text-popover-foreground shadow-[0_18px_48px_-24px_color-mix(in_srgb,var(--primary)_38%,transparent)] backdrop-blur-xl">
                  <button
                    onClick={() => {
                      setTheme('light');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-primary',
                      theme === 'light' && 'bg-accent text-primary',
                    )}
                  >
                    <Sun className="w-4 h-4" />
                    {t('settings.themeOptions.light')}
                  </button>
                  <button
                    onClick={() => {
                      setTheme('dark');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-primary',
                      theme === 'dark' && 'bg-accent text-primary',
                    )}
                  >
                    <Moon className="w-4 h-4" />
                    {t('settings.themeOptions.dark')}
                  </button>
                  <button
                    onClick={() => {
                      setTheme('system');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-primary',
                      theme === 'system' && 'bg-accent text-primary',
                    )}
                  >
                    <Monitor className="w-4 h-4" />
                    {t('settings.themeOptions.system')}
                  </button>
                </div>
              )}
            </div>

            <div className="w-[1px] h-4 bg-border" />

            {/* Settings Button */}
            <div className="relative">
              <button
                onClick={() => setSettingsOpen(true)}
                className="group rounded-xl p-2 text-muted-foreground transition-all hover:bg-accent hover:text-primary hover:shadow-sm"
              >
                <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
              </button>
            </div>
          </div>
        </div>
      </header>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      {/* Quiet structural background: course workspace, not a marketing hero. */}
      <div className="pointer-events-none absolute inset-x-0 top-16 h-[420px] overflow-hidden bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_7%,var(--background))_0%,var(--background)_100%)]">
        <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:32px_32px]" />
      </div>

      {/* ═══ Course-space dashboard ═══ */}
      <motion.div
        initial={heroEnter({ opacity: 0, y: 20 })}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative z-20 mt-8 grid w-full max-w-6xl grid-cols-1 gap-5 px-4 md:mt-12 md:px-8 lg:grid-cols-12"
      >
        <motion.div
          initial={heroEnter({ opacity: 0, y: 10 })}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mb-2 lg:col-span-12"
        >
          <div className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-primary">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('home.createEyebrow')}
          </div>
          {isCreateExperience && (
            <div
              className="mb-4 flex items-center gap-2 text-[11px] font-medium text-muted-foreground"
              aria-label={locale === 'zh-CN' ? '创建课程步骤 1 / 3' : 'Course creation step 1 of 3'}
            >
              <span className="rounded-full bg-primary px-2 py-1 text-primary-foreground">1</span>
              <span className="font-semibold text-primary">
                {locale === 'zh-CN' ? '课程内容' : 'Course content'}
              </span>
              <span className="h-px w-8 bg-border" />
              <span>2 {locale === 'zh-CN' ? '课程计划' : 'Course plan'}</span>
              <span className="h-px w-8 bg-border" />
              <span>3 {locale === 'zh-CN' ? '互动课堂' : 'Classroom'}</span>
            </div>
          )}
          <h1 className="max-w-[760px] text-balance text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-foreground sm:text-[34px]">
            {isLearningExperience
              ? locale === 'zh-CN'
                ? '从一个明确目标，构建你的学习路径'
                : 'Build a learning path from one clear goal'
              : t('home.createTitle')}
          </h1>
          <p className="mt-3 max-w-[720px] text-pretty text-sm leading-6 text-muted-foreground">
            {isLearningExperience
              ? locale === 'zh-CN'
                ? '创建概念理解任务，知构 AI 会生成与目标关联的课堂，并持续记录笔记与复习重点。'
                : 'Create a concept task linked to a classroom, notes, and review priorities.'
              : t('home.createDescription')}
          </p>
        </motion.div>

        {/* ── Unified input area ── */}
        <motion.div
          initial={heroEnter({ opacity: 0, scale: 0.97 })}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.35 }}
          className="w-full lg:col-span-8"
        >
          <div
            data-pro-morph="composer"
            className="w-full rounded-2xl border border-border/80 bg-card shadow-[0_18px_50px_-34px_rgba(16,42,67,0.42)] transition-[border-color,box-shadow] focus-within:border-primary/35 focus-within:shadow-[0_22px_60px_-32px_color-mix(in_oklab,var(--primary)_38%,transparent)]"
          >
            {isLearningExperience ? (
              <TaskCreateFields
                value={learningInput}
                errors={learningErrors}
                locale={locale}
                disabled={preparingGenerate}
                onChange={(next) => {
                  setLearningInput(next);
                  setLearningErrors({});
                  setError(null);
                }}
              />
            ) : null}
            {/* ── Greeting + Profile + Agents ── */}
            <div className="relative z-20 flex min-w-0 items-start justify-between">
              <GreetingBar />
              <div className="pr-3 pt-3.5 shrink-0">
                <AgentBar />
              </div>
            </div>

            {/* Textarea */}
            <textarea
              data-testid="course-requirement-input"
              ref={textareaRef}
              placeholder={t('upload.requirementPlaceholder')}
              className="min-h-[150px] max-h-[300px] w-full resize-none border-0 bg-transparent px-5 pb-3 pt-2 text-[14px] leading-relaxed placeholder:text-muted-foreground/45 focus:outline-none"
              value={form.requirement}
              onChange={(e) => updateForm('requirement', e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
            />

            {/* Toolbar row */}
            <div className="flex flex-wrap items-end gap-2 px-3 pb-3 sm:flex-nowrap">
              <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                <GenerationToolbar
                  webSearch={form.webSearch}
                  onWebSearchChange={(v) => updateForm('webSearch', v)}
                  onSettingsOpen={(section) => {
                    setSettingsSection(section);
                    setSettingsOpen(true);
                  }}
                  courseMaterials={form.courseMaterials}
                  onCourseMaterialsAdd={addCourseMaterials}
                  onCourseMaterialRemove={removeCourseMaterial}
                  onPdfError={setError}
                  materialsLocked={preparingGenerate}
                />
              </div>

              {/* Interactive mode toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <InteractiveModeButton
                    pressed={form.interactiveMode}
                    label={t('toolbar.interactiveModeLabel')}
                    onPressedChange={(pressed) => updateForm('interactiveMode', pressed)}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('toolbar.interactiveModeHint')}
                </TooltipContent>
              </Tooltip>

              {/* Voice input */}
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

              {/* Send button */}
              <button
                data-testid="course-generate-submit"
                onClick={handleGenerate}
                disabled={!canGenerate || preparingGenerate}
                className={cn(
                  'shrink-0 h-8 rounded-lg flex items-center justify-center gap-1.5 transition-all px-3',
                  canGenerate && !preparingGenerate
                    ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm cursor-pointer'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
                )}
              >
                <span className="text-xs font-medium">
                  {preparingGenerate
                    ? t('stage.generating')
                    : isLearningExperience
                      ? locale === 'zh-CN'
                        ? '生成目标课程'
                        : 'Generate learning course'
                      : isCreateExperience
                        ? locale === 'zh-CN'
                          ? '生成课程计划'
                          : 'Generate course plan'
                        : t('toolbar.enterClassroom')}
                </span>
                {preparingGenerate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        </motion.div>

        <motion.aside
          initial={heroEnter({ opacity: 0, x: 12 })}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
          className="relative min-h-[254px] overflow-hidden rounded-2xl border border-primary/15 bg-primary p-6 text-primary-foreground shadow-[0_22px_60px_-36px_color-mix(in_oklab,var(--primary)_70%,transparent)] lg:col-span-4 lg:row-span-3"
        >
          <div className="absolute -right-16 -top-20 size-52 rounded-full border-[34px] border-white/10" />
          <div className="absolute -bottom-14 right-8 size-32 rounded-full bg-white/[0.06]" />
          <div className="relative flex h-full flex-col">
            <span className="flex size-10 items-center justify-center rounded-xl bg-white/12">
              <Clock className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/65">
              {!isDashboardExperience
                ? locale === 'zh-CN'
                  ? isLearningExperience
                    ? '目标学习模式'
                    : '创建指引'
                  : isLearningExperience
                    ? 'Goal-based learning'
                    : 'Creation guide'
                : t('classroom.recentClassrooms')}
            </p>
            {latestClassroom && isDashboardExperience ? (
              <>
                <h2 className="mt-2 line-clamp-2 text-xl font-semibold leading-snug">
                  {latestClassroom.name}
                </h2>
                <p className="mt-2 text-sm text-primary-foreground/65">
                  {formatDate(latestClassroom.updatedAt)}
                </p>
                <button
                  type="button"
                  onClick={() => router.push(`/classroom/${latestClassroom.id}`)}
                  className="mt-auto inline-flex h-10 w-fit items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-primary transition-transform hover:-translate-y-0.5"
                >
                  {locale === 'zh-CN' ? '继续课程' : 'Continue course'}
                  <ChevronRight className="size-4" />
                </button>
              </>
            ) : (
              <>
                <h2 className="mt-2 text-xl font-semibold leading-snug">
                  {locale === 'zh-CN' ? '三步生成互动课程' : 'Create in three steps'}
                </h2>
                <ol className="mt-5 space-y-3 text-sm text-primary-foreground/75">
                  {[
                    locale === 'zh-CN' ? '描述课程主题与教学目标' : 'Describe the topic and goals',
                    locale === 'zh-CN' ? '确认 AI 生成的课程方案' : 'Review the AI course plan',
                    locale === 'zh-CN' ? '进入课堂开展互动学习' : 'Enter the interactive classroom',
                  ].map((step, index) => (
                    <li key={step} className="flex items-center gap-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-white">
                        {index + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-auto text-xs leading-5 text-primary-foreground/55">
                  {locale === 'zh-CN'
                    ? '从左侧输入课程需求即可开始'
                    : 'Start by entering your course request on the left'}
                </p>
              </>
            )}
          </div>
        </motion.aside>

        {showVocationalTestUi && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-2 flex w-full justify-start px-1 lg:col-span-8"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.vocationalTestMode}
                  onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                  className={cn(
                    'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                    form.vocationalTestMode
                      ? 'border-cyan-400/70 bg-cyan-50 text-cyan-700 shadow-[0_0_10px_rgba(6,182,212,0.16)] dark:bg-cyan-950/40 dark:text-cyan-300'
                      : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/60 hover:text-cyan-700 dark:hover:text-cyan-300',
                  )}
                >
                  <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-cyan-700 dark:bg-cyan-900/45 dark:text-cyan-300">
                    测试功能
                  </span>
                  <Sparkles className="size-3.5" />
                  <span>职教任务</span>
                  <span
                    className={cn(
                      'relative h-3.5 w-6 rounded-full transition-colors',
                      form.vocationalTestMode ? 'bg-cyan-500' : 'bg-muted-foreground/25',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform',
                        form.vocationalTestMode ? 'translate-x-2.5' : 'translate-x-0',
                      )}
                    />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                从当前输入框提交职教实操训练测试
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}

        {/* ── Error ── */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 w-full rounded-lg border border-destructive/20 bg-destructive/10 p-3 lg:col-span-8"
            >
              <p className="text-sm text-destructive">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {isDashboardExperience ? <RecentTaskList /> : null}

      {/* ═══ Course library — collapsible ═══ */}
      {/* The library action bar is always present after hydration: it carries
          the New-folder / import / search actions, so a brand-new user with
          zero courses and zero folders can still create the first folder or
          import. One stable action surface across root, folder, and empty. */}
      {!hydrated && isDashboardExperience && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label={t('common.loading')}
          className="relative z-10 mt-12 w-[calc(100%-2rem)] max-w-[1088px] overflow-hidden rounded-[28px] border border-border/70 bg-card/80 p-4 shadow-[0_24px_70px_-48px_rgba(16,42,67,0.55)] backdrop-blur-sm md:mt-16 md:w-[calc(100%-4rem)] md:p-6"
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <BookOpen className="size-5 animate-pulse" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 space-y-2">
              <span className="block h-5 w-32 animate-pulse rounded-md bg-muted" />
              <span className="block h-3 w-52 max-w-full animate-pulse rounded bg-muted/70" />
            </span>
          </div>

          <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="overflow-hidden rounded-2xl border border-border/60 bg-background/60"
              >
                <div className="aspect-[16/9] animate-pulse bg-muted/70" />
                <div className="space-y-3 p-4">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/5 animate-pulse rounded bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
      {hydrated && isDashboardExperience && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="relative z-10 mt-12 w-[calc(100%-2rem)] max-w-[1088px] overflow-hidden rounded-[28px] border border-border/70 bg-card/80 p-4 shadow-[0_24px_70px_-48px_rgba(16,42,67,0.55)] backdrop-blur-sm md:mt-16 md:w-[calc(100%-4rem)] md:p-6"
        >
          <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => {
                if (currentFolderId) setCurrentFolderId(undefined);
                else persistRecentOpen(!recentOpen);
              }}
              className="group/library min-w-0 text-left"
            >
              <span className="flex items-center gap-2.5">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
                  <BookOpen className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
                    {t('classroom.recentClassrooms')}
                    {currentFolder && (
                      <>
                        <ChevronRight className="size-4 text-muted-foreground/50" />
                        <span className="max-w-[180px] truncate">{currentFolder.name}</span>
                      </>
                    )}
                    <span className="rounded-lg bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
                      {currentFolder ? currentFolderClassrooms.length : classrooms.length}
                    </span>
                    <motion.span
                      animate={{ rotate: recentOpen ? 180 : 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="ml-1 text-muted-foreground transition-colors group-hover/library:text-primary"
                    >
                      <ChevronDown className="size-4" />
                    </motion.span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground sm:text-[13px]">
                    {t('home.libraryDescription')}
                  </span>
                </span>
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground select-none">
              {/* Search toggle — icon that expands into an input in place */}
              <AnimatePresence initial={false}>
                {!searchOpen ? (
                  <motion.button
                    key="search-icon"
                    ref={searchButtonRef}
                    type="button"
                    aria-label={t('classroom.searchAriaLabel')}
                    onClick={() => {
                      setSearchOpen(true);
                      if (!recentOpen) persistRecentOpen(true);
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex size-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-primary/25 hover:bg-primary/[0.06] hover:text-primary cursor-pointer"
                  >
                    <Search className="size-3.5" />
                  </motion.button>
                ) : (
                  <motion.div
                    key="search-input"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 200 }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    <InputGroup
                      className={cn(
                        'h-9 text-[12px] rounded-xl bg-background border-border/60 shadow-none',
                        'transition-colors',
                        'hover:bg-muted/60',
                        'has-[[data-slot=input-group-control]:focus-visible]:bg-muted/60',
                        'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
                        'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                      )}
                    >
                      <InputGroupInput
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            if (searchQuery) {
                              setSearchQuery('');
                            } else {
                              setSearchOpen(false);
                              requestAnimationFrame(() => searchButtonRef.current?.focus());
                            }
                          }
                        }}
                        onBlur={() => {
                          if (!searchQuery) {
                            setSearchOpen(false);
                          }
                        }}
                        placeholder={t('classroom.searchPlaceholder')}
                        aria-label={t('classroom.searchAriaLabel')}
                        className="h-9 pl-3 placeholder:text-muted-foreground/50"
                      />
                      {searchQuery && (
                        <InputGroupButton
                          size="icon-xs"
                          aria-label={t('classroom.clearSearch')}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSearchQuery('');
                            searchInputRef.current?.focus();
                          }}
                        >
                          <X />
                        </InputGroupButton>
                      )}
                    </InputGroup>
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                onClick={triggerImport}
                disabled={importing}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-2.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/25 hover:bg-primary/[0.06] hover:text-primary cursor-pointer"
              >
                <Upload className="size-3.5" />
                <span className="hidden whitespace-nowrap sm:inline">{t('import.classroom')}</span>
              </button>
              {PPTX_IMPORT_ENABLED && (
                <button
                  onClick={triggerPptxFileSelect}
                  disabled={pptxImporting}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-2.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/25 hover:bg-primary/[0.06] hover:text-primary cursor-pointer"
                >
                  <Presentation className="size-3.5" />
                  <span className="hidden whitespace-nowrap sm:inline">{t('import.pptx')}</span>
                </button>
              )}
              {/* New folder — round icon button, matches the import/upload affordances. */}
              {!currentFolderId && !isSearching && (
                <button
                  type="button"
                  onClick={() => {
                    if (!recentOpen) persistRecentOpen(true);
                    setNewFolderOpen(true);
                  }}
                  aria-label={t('classroom.newFolderTitle')}
                  title={t('classroom.newFolderTitle')}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 text-primary-foreground shadow-sm transition-opacity hover:opacity-90 cursor-pointer"
                >
                  <FolderPlus className="size-4" />
                  <span className="hidden whitespace-nowrap md:inline">
                    {t('classroom.newFolderTitle')}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Expandable content */}
          <AnimatePresence>
            {recentOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="w-full overflow-hidden"
              >
                {folders.length === 0 && classrooms.length === 0 ? (
                  <div className="mt-6 flex flex-col items-center rounded-2xl border border-dashed border-primary/20 bg-primary/[0.035] px-4 py-12 text-center">
                    <span className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/[0.06] text-primary">
                      <Sparkles className="size-6" aria-hidden="true" />
                    </span>
                    <h3 className="text-base font-semibold text-foreground">
                      {t('home.emptyLibraryTitle')}
                    </h3>
                    <p className="mt-1.5 max-w-md text-[13px] leading-5 text-muted-foreground">
                      {t('classroom.emptyLibraryHint')}
                    </p>
                  </div>
                ) : !isSearching && currentFolderId && currentFolderClassrooms.length === 0 ? (
                  // Empty folder: hint directly below the centered path bar.
                  <div className="pt-8 text-center">
                    <p className="text-[14px] text-muted-foreground">
                      {t('classroom.emptyFolderHint')}
                    </p>
                  </div>
                ) : isSearching && filteredClassrooms.length === 0 ? (
                  <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                    {t('classroom.searchEmpty')}
                  </div>
                ) : (
                  <div className="pt-7">
                    {/* Breadcrumb — shown only while searching (the folder path
                        already lives in the centered header above). */}
                    {isSearching && (
                      <div className="mb-4 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => {
                            setCurrentFolderId(undefined);
                            setSearchQuery('');
                            setSearchOpen(false);
                          }}
                          className="hover:text-foreground transition-colors"
                        >
                          {t('classroom.recentClassrooms')}
                        </button>
                        <ChevronRight className="size-3.5" />
                        <span className="text-foreground font-medium">
                          {t('classroom.searchResults')}
                        </span>
                        <span className="ml-1.5 text-[12px] text-muted-foreground tabular-nums">
                          ({filteredClassrooms.length})
                        </span>
                      </div>
                    )}

                    <AnimatePresence mode="wait">
                      <motion.div
                        key={
                          isSearching
                            ? 'search'
                            : currentFolderId
                              ? `folder-${currentFolderId}`
                              : 'root'
                        }
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                      >
                        {/* Root + non-search: render folder tiles first. */}
                        {!isSearching &&
                          currentFolderId === undefined &&
                          folders.map((folder, i) => (
                            <motion.div
                              key={folder.id}
                              initial={{ opacity: 0, y: 16 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                            >
                              <FolderCard
                                folder={folder}
                                courseCount={courseCountByFolder.get(folder.id) ?? 0}
                                coverSlides={coverSlidesByFolder.get(folder.id) ?? []}
                                onOpen={() => setCurrentFolderId(folder.id)}
                                onRename={handleRenameFolder(folder)}
                                onDelete={(mode) => confirmDeleteFolder(folder, mode)}
                                onDropCourse={(stageId) => handleMoveCourse(stageId, folder.id)}
                              />
                            </motion.div>
                          ))}

                        {/* Course tiles for the active view. */}
                        {visibleClassrooms.map((classroom, i) => (
                          <motion.div
                            key={classroom.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                          >
                            <ClassroomCard
                              classroom={classroom}
                              slide={thumbnails[classroom.id]}
                              formatDate={formatDate}
                              onDelete={handleDelete}
                              onRename={handleRename}
                              confirmingDelete={pendingDeleteId === classroom.id}
                              onConfirmDelete={() => confirmDelete(classroom.id)}
                              onCancelDelete={() => setPendingDeleteId(null)}
                              onClick={() => router.push(`/classroom/${classroom.id}`)}
                              overlay={
                                <>
                                  <MoveToFolderMenu
                                    folders={folders}
                                    currentFolderId={classroom.folderId}
                                    onMove={(folderId) => handleMoveCourse(classroom.id, folderId)}
                                    onCreateAndMove={handleCreateAndMove(classroom.id)}
                                  />
                                  {/* Search view: show the owning folder as a badge. */}
                                  {isSearching && classroom.folderId && (
                                    <span className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-primary/85 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground backdrop-blur-sm pointer-events-none">
                                      <Folder className="size-2.5" />
                                      {folderNameById.get(classroom.folderId) ?? ''}
                                    </span>
                                  )}
                                </>
                              }
                            />
                          </motion.div>
                        ))}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Folder dialogs — mounted at the top level so they are reachable even
          while the Recent section is collapsed or the course list is empty. */}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setCreateAndMoveTarget(null);
        }}
        folders={folders}
        onCreate={handleCreateFolder}
      />

      {/* Footer — flows with content, at the very end */}
      <div className="mt-auto flex items-center gap-1.5 pt-12 pb-4 text-center text-xs text-muted-foreground/45">
        <span>{brand.productName}</span>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/THU-MAIC/OpenMAIC"
          target="_blank"
          rel="noreferrer"
          title={
            locale === 'zh-CN'
              ? '本项目基于 OpenMAIC 开源项目进行二次开发'
              : 'Built as a secondary development based on the open-source OpenMAIC project'
          }
          className="transition-colors hover:text-primary"
        >
          {locale === 'zh-CN' ? '关于项目' : 'About'}
        </a>
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
    <div ref={containerRef} className="relative min-w-0 flex-1 pb-1 pl-4 pr-2 pt-3.5 sm:flex-none">
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
          className="group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-full border border-border/50 px-2.5 py-1.5 text-muted-foreground/70 transition-all duration-200 hover:bg-muted/60 hover:text-foreground active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-primary/60 transition-all duration-300">
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
                  <span className="truncate whitespace-nowrap text-[13px] font-semibold text-foreground/85 transition-colors group-hover:text-foreground">
                    {t('home.greetingWithName', { name: displayName })}
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
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-primary/55 transition-all duration-300">
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
                        className="shrink-0 size-5 rounded flex items-center justify-center text-primary hover:bg-accent"
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
                                ? 'ring-2 ring-primary ring-offset-0'
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
                              ? 'ring-2 ring-primary ring-offset-0 border-primary/40 bg-accent'
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
  overlay,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  formatDate: (ts: number) => string;
  /** Extra absolutely-positioned layers over the thumbnail (move menu, badges). */
  overlay?: React.ReactNode;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <article
      className="group cursor-pointer rounded-[22px] border border-border/70 bg-card/85 p-3 shadow-[0_12px_30px_-24px_rgba(16,42,67,0.42)] transition-all duration-300 hover:-translate-y-1.5 hover:border-primary/30 hover:shadow-[0_24px_46px_-28px_color-mix(in_srgb,var(--primary)_35%,transparent)]"
      onClick={confirmingDelete ? undefined : onClick}
      draggable={!confirmingDelete && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/stage-id', classroom.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        // Notify folder cards to clear any lingering drop highlight (Escape-
        // cancelled drags may not fire dragleave on every target).
        window.dispatchEvent(new CustomEvent('course-drag-end'));
      }}
    >
      {/* Course cover */}
      <div
        ref={thumbRef}
        className="relative aspect-[16/9] w-full overflow-hidden rounded-[15px] bg-slate-100 ring-1 ring-black/5 dark:bg-slate-800/80 dark:ring-white/5"
      >
        {slide && thumbWidth > 0 ? (
          <SlideThumbnail
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : !slide ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <BookOpen className="size-5" />
            </div>
          </div>
        ) : null}

        {showModeBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={modeBadgeLabel}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute bottom-2 left-2 inline-flex items-center justify-center size-5 rounded-full bg-white/70 dark:bg-slate-900/60 backdrop-blur-sm shadow-sm z-10',
                  isTaskEngineMode
                    ? 'text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/35'
                    : 'text-cyan-600 dark:text-cyan-300 ring-1 ring-cyan-500/30',
                )}
              >
                <ModeBadgeIcon className="size-3" />
              </span>
            </TooltipTrigger>
            {/* Negative sideOffset compensates for the global Tooltip Arrow's
                rotate-45 bounding box, which Radix reserves as spacing. */}
            <TooltipContent
              side="top"
              align="start"
              sideOffset={-4}
              collisionPadding={0}
              className="text-xs"
            >
              {modeBadgeLabel}
            </TooltipContent>
          </Tooltip>
        )}

        <span className="pointer-events-none absolute bottom-2 right-2 z-10 inline-flex translate-y-1 items-center gap-1 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[10px] font-semibold text-white opacity-0 shadow-sm backdrop-blur-sm transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
          {t('toolbar.enterClassroom')}
          <ChevronRight className="size-3" />
        </span>

        {/* Delete — top-right, only on hover */}
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
                aria-label={t('classroom.delete')}
                title={t('classroom.delete')}
                className="absolute top-2 right-2 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('classroom.rename')}
                title={t('classroom.rename')}
                className="absolute top-2 right-11 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={startRename}
              >
                <Pencil className="size-3.5" />
              </Button>
              {overlay}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
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

      <div className="flex min-h-[76px] flex-col px-1 pb-0.5 pt-3.5">
        {editing ? (
          <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commitRename}
              maxLength={100}
              placeholder={t('classroom.renamePlaceholder')}
              className="w-full border-b border-primary/60 bg-transparent text-[15px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="min-w-0 truncate text-[15px] font-semibold text-foreground cursor-text"
                onDoubleClick={startRename}
              >
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
                  className="shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors"
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
        )}
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <BookOpen className="size-3 text-primary" />
            {classroom.sceneCount} {t('classroom.slides')}
          </span>
          <span>{formatDate(classroom.updatedAt)}</span>
        </div>
      </div>
    </article>
  );
}

export default function Page() {
  return <HomePage />;
}
