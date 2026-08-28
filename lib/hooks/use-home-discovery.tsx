'use client';

/**
 * The homepage course tree — owned here so BOTH home shells can mount it.
 *
 * `/` (the ordinary homepage) and `/workspace` (the Pro workspace) are
 * separate routes, so they cannot share a React element the way the old
 * page-local `proMode` flag did. What they share instead is this hook: one
 * definition of the classroom list, its loading/rename/delete/import
 * behaviour and the folder management built from it. The routes are mutually
 * exclusive, so exactly one live instance exists at any time — the rule that
 * matters is "never two mounted copies", not "one module".
 *
 * The Pro sidebar's Courses list reads `classrooms` from this same hook rather
 * than firing its own `GET /api/stages`: two fetches of the same list can
 * disagree, and a sidebar that contradicts the course grid beside it is worse
 * than a sidebar that is one render late.
 *
 * The reference (live deployment) also renders the Discover/featured feed
 * through this hook and branches on `isLiveMode`. This workspace is
 * self-deploy and single-owner: `listStages` reads the local storage boundary,
 * every course is the user's own (`isOwner` is absent), and there is no
 * Discover feed to render — the workspace's discover-only mode therefore
 * leaves the feed slot empty, exactly as the reference does outside live mode.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import {
  listStages,
  deleteStageData,
  listFolders,
  createFolder,
  setStageFolder,
  type StageListItem,
} from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/utils/database';
import { NewFolderDialog } from '@/components/discovery/folder-dialogs';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import { createCoalescedLatestLoader } from '@/lib/workbench/course-discovery-sync';

const log = createLogger('HomeDiscovery');

export type HomeDiscoveryState = 'loading' | 'ready' | 'error';

/**
 * What the mounting shell wants below its composer.
 *
 * `full` — the classic home: Discover + My Courses + folders + breadcrumb.
 * `discover-only` — the Pro workspace: the featured feed and nothing else,
 * because `/workspace` moved course management into its left nav tree and two
 * course managers on one screen contradict each other.
 *
 * This is a parameter rather than a second hook on purpose: both routes keep
 * ONE data layer (one `listStages`, one `listFolders`, one folder dialog), and
 * only the rendered surface differs.
 */
export type HomeDiscoveryMode = 'full' | 'discover-only';

export interface HomeDiscoveryOptions {
  readonly mode?: HomeDiscoveryMode;
}

/** The subset of `StageListItem` the workspace reads. */
export interface DiscoveryCourse extends StageListItem {
  /** `false` = saved from Discover; `true`/absent = the user's own. */
  readonly isOwner?: boolean;
}

export interface HomeDiscovery {
  /** The user's classrooms, in the API's own order (newest-first is a view concern). */
  readonly classrooms: DiscoveryCourse[];
  readonly state: HomeDiscoveryState;
  readonly reload: () => Promise<void>;
  /** Hidden ZIP file input — mount it anywhere in the shell. */
  readonly importInput: ReactElement;
  /** Open the mounted ZIP picker. Shared by the home library and Pro course tree. */
  readonly triggerImport: () => void;
  readonly importing: boolean;
  /** The discovery/featured tree. Mount at most one of these per page. */
  readonly discoveryContent: ReactElement;
  /** The user's folders, for shells that render their own course tree. */
  readonly folders: FolderRecord[];
  /** Open the (already-mounted) new-folder dialog. */
  readonly openNewFolder: () => void;
  /** File a course into a folder, or out of one with `undefined`. */
  readonly moveCourse: (stageId: string, folderId: string | undefined) => Promise<void> | void;
  /** Curried: open the folder dialog, then move this course into what it creates. */
  readonly createAndMove: (stageId: string) => () => void;
  /**
   * Tombstone an authored course and remove it from this hook's list.
   * Resolves true when the delete landed, false when it failed (a failure is
   * toasted here and the authoritative list reloaded, so the caller can treat
   * it as "nothing was deleted").
   */
  readonly deleteCourse: (stageId: string) => Promise<boolean>;
}

export function useHomeDiscovery({
  mode: _mode = 'full',
}: HomeDiscoveryOptions = {}): HomeDiscovery {
  const { t } = useI18n();
  const [classrooms, setClassrooms] = useState<DiscoveryCourse[]>([]);
  const [state, setState] = useState<HomeDiscoveryState>('loading');
  const stateRef = useRef<HomeDiscoveryState>('loading');

  // Course folders — folder navigation and the new-folder dialog ride along so
  // both home shells share one folder data layer.
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // When set, the new-folder dialog is creating a folder AND moving this course
  // into it (entered via the move-menu's "new folder" entry).
  const [createAndMoveTarget, setCreateAndMoveTarget] = useState<string | null>(null);

  // One coalesced loader per list, created lazily on first use (not during
  // render). A response is committed only when no newer request was made while
  // it was in flight, so an old course-list snapshot can never win.
  const classroomLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const loadClassrooms = useCallback(() => {
    if (!classroomLoaderRef.current) {
      classroomLoaderRef.current = createCoalescedLatestLoader({
        load: listStages,
        commit: (list) => {
          setClassrooms(list);
          stateRef.current = 'ready';
          setState('ready');
        },
        fail: (err) => {
          log.error('Failed to load classrooms:', err);
          // A background reconciliation must not replace an already-usable tree
          // with error chrome because of one transient read failure. Initial
          // loading and explicit retries still surface the persistence error.
          if (stateRef.current === 'ready') return;
          stateRef.current = 'error';
          setState('error');
          toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
        },
      });
    }
    return classroomLoaderRef.current();
  }, []);

  const folderLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const loadFolders = useCallback(() => {
    if (!folderLoaderRef.current) {
      folderLoaderRef.current = createCoalescedLatestLoader({
        load: listFolders,
        commit: setFolders,
        fail: (err) => log.error('Failed to load folders:', err),
      });
    }
    return folderLoaderRef.current();
  }, []);

  const reload = useCallback(async () => {
    // Keep an already-usable tree visible during background reconciliation;
    // only a retry from the error state needs to return to loading chrome.
    if (stateRef.current === 'error') {
      stateRef.current = 'loading';
      setState('loading');
    }
    await Promise.all([loadClassrooms(), loadFolders()]);
  }, [loadClassrooms, loadFolders]);

  // ZIP import. This build has no folder navigation (courses live in the
  // workspace's nav tree), so an import lands unfiled; the list refresh below
  // is the whole follow-up.
  const {
    importing: isImporting,
    fileInputRef: importFileInputRef,
    triggerFileSelect,
    handleFileChange: handleImportFileChange,
  } = useImportClassroom(async () => {
    // The import hook already toasts success; refresh the authoritative list
    // so the new course appears in every shell reading it.
    await loadClassrooms();
  });
  const triggerImport = () => {
    triggerFileSelect();
  };

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    void Promise.all([loadClassrooms(), loadFolders()]);

    const onAuthChange = () => {
      void loadClassrooms();
      void loadFolders();
    };
    window.addEventListener('auth-change', onAuthChange);
    return () => window.removeEventListener('auth-change', onAuthChange);
  }, [loadClassrooms, loadFolders]);

  const deleteCourse = useCallback(
    async (id: string): Promise<boolean> => {
      setClassrooms((prev) => prev.filter((course) => course.id !== id));
      try {
        await deleteStageData(id);
        // Invalidate any list snapshot that started before the optimistic
        // deletion, then converge on the authoritative post-delete list.
        await loadClassrooms();
        return true;
      } catch (err) {
        log.error('Failed to delete classroom:', err);
        toast.error(t('workspace.deleteFailed'));
        await loadClassrooms();
        return false;
      }
    },
    [loadClassrooms, t],
  );

  // ─── Folder handlers ────────────────────────────────────────────────
  const handleMoveCourse = async (stageId: string, folderId: string | undefined) => {
    // Optimistic update for snappy UI; the persistence call follows.
    setClassrooms((prev) => prev.map((c) => (c.id === stageId ? { ...c, folderId } : c)));
    try {
      await setStageFolder(stageId, folderId);
      // A generation-boundary refresh may still be in flight. Queue a newer
      // authoritative read so its pre-move snapshot cannot win afterwards.
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to move course:', err);
      toast.error(t('classroom.moveFailed'));
      // Revert on failure.
      await loadClassrooms();
    }
  };

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

  // From the move-menu's "new folder" entry: remember the course, then open the
  // folder dialog. The actual create+move happens in handleCreateFolder once the
  // name is confirmed. (A Radix DropdownMenu is modal, so the name input cannot
  // live inside it; the dialog is the focus surface.)
  const handleCreateAndMove = (stageId: string) => () => {
    setCreateAndMoveTarget(stageId);
    setNewFolderOpen(true);
  };

  const importInput = (
    <input
      ref={importFileInputRef}
      type="file"
      accept=".zip"
      className="hidden"
      onChange={handleImportFileChange}
    />
  );

  // One discovery tree per shell. This workspace has no Discover feed (there
  // is nobody else's work to discover), so the slot stays empty in both modes
  // and only the shared new-folder dialog rides along — it must stay mounted
  // even while the course list is empty, and Radix portals it to the body
  // anyway, so its position in the tree is irrelevant as long as it is mounted
  // exactly once.
  const discoveryContent = (
    <>
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setCreateAndMoveTarget(null);
        }}
        folders={folders}
        onCreate={handleCreateFolder}
      />
    </>
  );

  return {
    classrooms,
    state,
    reload,
    importInput,
    triggerImport,
    importing: isImporting,
    discoveryContent,
    folders,
    openNewFolder: () => setNewFolderOpen(true),
    moveCourse: handleMoveCourse,
    createAndMove: handleCreateAndMove,
    deleteCourse,
  };
}
