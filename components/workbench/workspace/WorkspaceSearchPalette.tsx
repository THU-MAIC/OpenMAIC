'use client';

/**
 * The workspace's global search: a command palette opened by ⌘K (Ctrl+K off
 * the Mac) or the rail's Search row.
 *
 * It finds things by NAME across the three kinds of work a teacher keeps —
 * conversations, courses (with the folder each is filed in) and knowledge-base
 * materials — grouped by kind, and opens a result exactly as clicking it
 * elsewhere would: the shell hands in the same handlers the rail, the My
 * courses page and the knowledge base use. With nothing typed it offers the
 * recent conversations and courses and the main actions (a new chat, My
 * courses, the knowledge base, settings); typed, the actions are found by
 * name too — those, the theme and language switches and the host's pages —
 * matched on their label and on English and Chinese aliases.
 *
 * Conversations and courses are already in memory (the rail's and the
 * library's own lists), so they are filtered as the query is typed. Materials
 * live behind the library listing, so they are asked for once typing settles,
 * with the request in flight cancelled when the query moves on. No message
 * text is searched.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  FileText,
  Folder,
  Languages,
  Library,
  MessageSquare,
  Monitor,
  Moon,
  Search,
  Settings,
  SquarePen,
  SunMedium,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { supportedLocales } from '@/lib/i18n';
import {
  useWorkbenchShellExtensions,
  type WorkbenchShellIcon,
} from '@/lib/workbench/shell-extensions';
import { Command as CommandPrimitive } from 'cmdk';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { shortcutLabel, useIsMac } from '@/lib/workbench/shortcuts';
import { matchesQuery } from '@/lib/workbench/workspace-tree';
import { workbenchSessionTitle } from '@/lib/workbench/session-title';
import type { ProHomeSessionItem } from '@/lib/workbench/pro-home-data';
import {
  fetchMaterialLibraryPage,
  type LibraryMaterial,
} from '@/lib/workbench/material-library-client';

/** How long typing settles before the knowledge base is asked. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Rows per group: a palette is for jumping, not browsing. */
const GROUP_LIMIT = 6;
/** Recent rows per group with nothing typed. */
const RECENT_LIMIT = 4;

export interface SearchCourse {
  readonly id: string;
  readonly name?: string;
  readonly folderId?: string;
  readonly updatedAt: number;
}

export interface SearchFolder {
  readonly id: string;
  readonly name: string;
}

/** Something the workbench can do, listed with nothing typed (when `primary`) or found by name. */
interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly icon: WorkbenchShellIcon;
  /** Matched too, in English and Chinese, so either finds it in any UI language. */
  readonly keywords: readonly string[];
  readonly hint?: string;
  readonly primary?: boolean;
  readonly run: () => void;
}

/** The knowledge base's answer for one query. */
type MaterialAnswer =
  | { readonly query: string; readonly materials: readonly LibraryMaterial[] }
  | { readonly query: string; readonly failed: true };

export function WorkspaceSearchPalette({
  open,
  onOpenChange,
  sessions,
  courses,
  folders,
  onOpenSession,
  onOpenCourse,
  onOpenMaterial,
  onNewSession,
  onOpenView,
  onOpenSettings,
  coursesView,
  libraryView,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessions: readonly ProHomeSessionItem[];
  readonly courses: readonly SearchCourse[];
  readonly folders: readonly SearchFolder[];
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenCourse: (courseId: string) => void;
  readonly onOpenMaterial: (material: LibraryMaterial) => void;
  readonly onNewSession: () => void;
  readonly onOpenView: (view: string) => void;
  readonly onOpenSettings: () => void;
  readonly coursesView: string;
  readonly libraryView: string;
}) {
  const { t, setLocale } = useI18n();
  const { setTheme } = useTheme();
  const extensions = useWorkbenchShellExtensions();
  const newChatHint = shortcutLabel('newChat', useIsMac()).label;
  const [query, setQuery] = useState('');
  const trimmed = query.trim();

  // ── Materials: asked once typing settles ────────────────────────────
  // Only an answer for the query on screen counts; until it arrives the
  // group says it is searching.
  const [answer, setAnswer] = useState<MaterialAnswer | null>(null);
  useEffect(() => {
    if (!open || !trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchMaterialLibraryPage({
        scope: { kind: 'all' },
        query: trimmed,
        withLimits: false,
        signal: controller.signal,
      }).then(
        (page) => setAnswer({ query: trimmed, materials: page.materials }),
        () => {
          if (!controller.signal.aborted) setAnswer({ query: trimmed, failed: true });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed]);

  // ── Conversations and courses: filtered in place ────────────────────
  const folderNames = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const sessionRows = useMemo(() => {
    const newest = [...sessions].sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
    );
    const named = newest.map((session) => ({
      id: session.id,
      name: workbenchSessionTitle(session) ?? t('workspace.untitledSession'),
    }));
    return trimmed
      ? named.filter((row) => matchesQuery(row.name, trimmed)).slice(0, GROUP_LIMIT)
      : named.slice(0, RECENT_LIMIT);
  }, [sessions, t, trimmed]);
  const courseRows = useMemo(() => {
    const newest = [...courses].sort((a, b) => b.updatedAt - a.updatedAt);
    const named = newest.map((course) => ({
      id: course.id,
      name: course.name || t('workspace.untitledCourse'),
      folder: course.folderId ? (folderNames.get(course.folderId) ?? null) : null,
    }));
    return trimmed
      ? named
          // The folder is context, and a place to look: "Math" finds what is filed there.
          .filter(
            (row) => matchesQuery(row.name, trimmed) || matchesQuery(row.folder ?? '', trimmed),
          )
          .slice(0, GROUP_LIMIT)
      : named.slice(0, RECENT_LIMIT);
  }, [courses, folderNames, t, trimmed]);

  const current = answer && answer.query === trimmed ? answer : null;
  const materialRows =
    current && 'materials' in current ? current.materials.slice(0, GROUP_LIMIT) : [];
  const materialsFailed = !!current && 'failed' in current;
  const materialsPending = !!trimmed && !current;
  const nothing =
    !!trimmed &&
    !materialsPending &&
    sessionRows.length + courseRows.length + materialRows.length === 0;

  // ── Actions: what the workbench can do, found by name too ───────────
  const actions = useMemo((): readonly PaletteAction[] => {
    const themeAliases: Record<'light' | 'dark' | 'system', readonly string[]> = {
      light: ['light', '浅色', '亮色', '白天'],
      dark: ['dark', '深色', '暗色', '夜间'],
      system: ['system', 'auto', '跟随系统', '系统', '自动'],
    };
    const themeIcons = { light: SunMedium, dark: Moon, system: Monitor } as const;
    return [
      {
        id: 'new-chat',
        label: t('workspace.newSession'),
        icon: SquarePen,
        keywords: ['new chat', 'new conversation', 'new', '新建', '新对话', '新建对话', '对话'],
        hint: newChatHint,
        primary: true,
        run: onNewSession,
      },
      {
        id: 'my-courses',
        label: t('workspace.nav.myCourses'),
        icon: BookOpen,
        keywords: ['my courses', 'courses', 'course', '我的课程', '课程'],
        primary: true,
        run: () => onOpenView(coursesView),
      },
      {
        id: 'library',
        label: t('workspace.knowledgeBase.title'),
        icon: Library,
        keywords: ['knowledge base', 'knowledge', 'library', 'materials', '知识库', '资料'],
        primary: true,
        run: () => onOpenView(libraryView),
      },
      {
        id: 'settings',
        label: t('settings.title'),
        icon: Settings,
        keywords: ['settings', 'preferences', 'models', 'providers', '设置', '模型', '偏好'],
        primary: true,
        run: onOpenSettings,
      },
      ...(['light', 'dark', 'system'] as const).map(
        (value): PaletteAction => ({
          id: `theme-${value}`,
          label: t('workspace.search.themeAction', {
            name: t(`settings.themeOptions.${value}`),
          }),
          icon: themeIcons[value],
          keywords: ['theme', 'appearance', '主题', '外观', ...themeAliases[value]],
          run: () => setTheme(value),
        }),
      ),
      ...supportedLocales.map(
        (entry): PaletteAction => ({
          id: `language-${entry.code}`,
          label: t('workspace.search.languageAction', { name: entry.label }),
          icon: Languages,
          keywords: ['language', 'languages', '语言', entry.label, entry.code],
          run: () => setLocale(entry.code),
        }),
      ),
      ...(extensions.navItems ?? []).map(
        (item): PaletteAction => ({
          id: `host-${item.id}`,
          label: item.label,
          icon: item.icon,
          keywords: [item.id],
          run: () => {
            if (item.render) onOpenView(item.id);
            else if (item.href) {
              if (item.external) window.open(item.href, '_blank', 'noopener');
              else window.location.assign(item.href);
            } else item.onSelect?.();
          },
        }),
      ),
    ];
  }, [
    coursesView,
    extensions.navItems,
    libraryView,
    newChatHint,
    onNewSession,
    onOpenSettings,
    onOpenView,
    setLocale,
    setTheme,
    t,
  ]);
  const actionRows = trimmed
    ? actions
        .filter(
          (action) =>
            matchesQuery(action.label, trimmed) ||
            action.keywords.some((keyword) => matchesQuery(keyword, trimmed)),
        )
        .slice(0, GROUP_LIMIT)
    : actions.filter((action) => action.primary);

  const choose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  // Found by a query, the actions lead; with nothing typed they follow the recent work.
  const actionGroup =
    actionRows.length > 0 ? (
      <CommandGroup
        className="ws-search-group"
        data-testid="workspace-search-group-actions"
        heading={t('workspace.search.actions')}
      >
        {actionRows.map((action) => {
          const Icon = action.icon;
          return (
            <CommandItem
              className="ws-search-item"
              key={action.id}
              value={`action:${action.id}`}
              data-testid={`workspace-search-action-${action.id}`}
              onSelect={() => choose(action.run)}
            >
              <Icon aria-hidden />
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.hint ? (
                <CommandShortcut data-testid={`workspace-search-action-${action.id}-shortcut`}>
                  {action.hint}
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    ) : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspace.nav.search')}
      description={t('workspace.search.placeholder')}
      className="sm:max-w-[560px]"
    >
      {/* Filtering is ours (by name, folder included); cmdk keeps the keyboard. */}
      <Command
        shouldFilter={false}
        loop
        className="rounded-none! p-0"
        data-testid="workspace-search"
      >
        {/* The input row is the palette's top edge, not a box inside it. */}
        <div className="ws-search-head">
          <Search className="size-[17px] shrink-0" aria-hidden="true" />
          <CommandPrimitive.Input
            data-testid="workspace-search-input"
            value={query}
            onValueChange={setQuery}
            placeholder={t('workspace.search.placeholder')}
            className="ws-search-input"
          />
        </div>
        <CommandList className="ws-search-list ws-scroll max-h-[min(440px,60vh)]">
          {nothing ? (
            <CommandEmpty data-testid="workspace-search-empty" className="ws-search-empty">
              {t('workspace.search.empty', { query: trimmed })}
            </CommandEmpty>
          ) : null}

          {trimmed ? actionGroup : null}

          {sessionRows.length > 0 ? (
            <CommandGroup
              className="ws-search-group"
              data-testid="workspace-search-group-chats"
              heading={
                trimmed ? t('workspace.sections.sessions') : t('workspace.search.recentChats')
              }
            >
              {sessionRows.map((row) => (
                <CommandItem
                  className="ws-search-item"
                  key={row.id}
                  value={`chat:${row.id}`}
                  data-testid={`workspace-search-chat-${row.id}`}
                  onSelect={() => choose(() => onOpenSession(row.id))}
                >
                  <MessageSquare aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {courseRows.length > 0 ? (
            <CommandGroup
              className="ws-search-group"
              data-testid="workspace-search-group-courses"
              heading={
                trimmed ? t('workspace.search.courses') : t('workspace.search.recentCourses')
              }
            >
              {courseRows.map((row) => (
                <CommandItem
                  className="ws-search-item"
                  key={row.id}
                  value={`course:${row.id}`}
                  data-testid={`workspace-search-course-${row.id}`}
                  onSelect={() => choose(() => onOpenCourse(row.id))}
                >
                  <BookOpen aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {row.folder ? (
                    <span className="ws-search-context">
                      <Folder className="size-3" aria-hidden="true" />
                      <span className="truncate">{row.folder}</span>
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {trimmed && (materialRows.length > 0 || materialsPending || materialsFailed) ? (
            <CommandGroup
              className="ws-search-group"
              data-testid="workspace-search-group-materials"
              heading={t('workspace.search.materials')}
            >
              {materialRows.map((material) => (
                <CommandItem
                  className="ws-search-item"
                  key={material.materialId}
                  value={`material:${material.materialId}`}
                  data-testid={`workspace-search-material-${material.materialId}`}
                  onSelect={() => choose(() => onOpenMaterial(material))}
                >
                  <FileText aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{material.name}</span>
                  {material.folderName ? (
                    <span className="ws-search-context">
                      <Folder className="size-3" aria-hidden="true" />
                      <span className="truncate">{material.folderName}</span>
                    </span>
                  ) : null}
                </CommandItem>
              ))}
              {materialsPending ? (
                <div data-testid="workspace-search-loading" className="ws-search-note">
                  {t('workspace.search.searching')}
                </div>
              ) : null}
              {materialsFailed ? (
                <div data-testid="workspace-search-materials-failed" className="ws-search-note">
                  {t('workspace.search.materialsFailed')}
                </div>
              ) : null}
            </CommandGroup>
          ) : null}
          {trimmed ? null : actionGroup}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
