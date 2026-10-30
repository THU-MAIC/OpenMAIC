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
 * recent conversations and courses and the three ways to start (a new chat,
 * My courses, the knowledge base).
 *
 * Conversations and courses are already in memory (the rail's and the
 * library's own lists), so they are filtered as the query is typed. Materials
 * live behind the library listing, so they are asked for once typing settles,
 * with the request in flight cancelled when the query moves on. No message
 * text is searched.
 */

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, FileText, Folder, Library, MessageSquare, SquarePen } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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

/** ⌘K on the Mac, Ctrl+K elsewhere: the palette's own shortcut. */
export function isSearchShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(platform);
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
  readonly coursesView: string;
  readonly libraryView: string;
}) {
  const { t } = useI18n();
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

  const choose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

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
        <CommandInput
          data-testid="workspace-search-input"
          value={query}
          onValueChange={setQuery}
          placeholder={t('workspace.search.placeholder')}
        />
        <CommandList className="max-h-[min(420px,60vh)] px-1 pb-1.5">
          {nothing ? (
            <CommandEmpty data-testid="workspace-search-empty">
              {t('workspace.search.empty', { query: trimmed })}
            </CommandEmpty>
          ) : null}

          {sessionRows.length > 0 ? (
            <CommandGroup
              data-testid="workspace-search-group-chats"
              heading={
                trimmed ? t('workspace.sections.sessions') : t('workspace.search.recentChats')
              }
            >
              {sessionRows.map((row) => (
                <CommandItem
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
              data-testid="workspace-search-group-courses"
              heading={
                trimmed ? t('workspace.search.courses') : t('workspace.search.recentCourses')
              }
            >
              {courseRows.map((row) => (
                <CommandItem
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
              data-testid="workspace-search-group-materials"
              heading={t('workspace.search.materials')}
            >
              {materialRows.map((material) => (
                <CommandItem
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

          {trimmed ? null : (
            <CommandGroup
              data-testid="workspace-search-group-actions"
              heading={t('workspace.search.actions')}
            >
              <CommandItem
                value="action:new-chat"
                data-testid="workspace-search-action-new-chat"
                onSelect={() => choose(onNewSession)}
              >
                <SquarePen aria-hidden="true" />
                <span className="flex-1">{t('workspace.newSession')}</span>
              </CommandItem>
              <CommandItem
                value="action:my-courses"
                data-testid="workspace-search-action-my-courses"
                onSelect={() => choose(() => onOpenView(coursesView))}
              >
                <BookOpen aria-hidden="true" />
                <span className="flex-1">{t('workspace.nav.myCourses')}</span>
              </CommandItem>
              <CommandItem
                value="action:library"
                data-testid="workspace-search-action-library"
                onSelect={() => choose(() => onOpenView(libraryView))}
              >
                <Library aria-hidden="true" />
                <span className="flex-1">{t('workspace.knowledgeBase.title')}</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
