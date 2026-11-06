'use client';

import { Fragment, useCallback, useMemo } from 'react';
import { Reorder } from 'motion/react';
import { PageRail } from '@/components/stage/page-rail';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { commitCourseEdit } from '@/lib/edit/course-edit';
import { duplicateSlideScene } from '@/lib/edit/slide-defaults';
import { useInsertSceneAt } from '@/lib/edit/use-insert-scene';
import { SCENE_CREATION_ENABLED } from '@/lib/edit/scene-creation-enabled';
import type { Scene } from '@/lib/types/stage';
import { ThumbItem } from './ThumbItem';
import { InsertionZone } from './InsertionZone';

/**
 * Pro mode slide-navigation left rail (Studio Editor aesthetic).
 *
 * Layout: a vertical thumbnail strip with monospaced index captions
 * below each tile, inter-thumb "+" insertion zones revealed on hover.
 * Its frame (width, collapse, resize, header) is `PageRail`, shared with Learn's
 * list so the two behave as one control. All scene types are
 * first-class — slides render a live `ThumbnailSlide`, non-slide scenes
 * get a type-icon stub but stay clickable, draggable, and right-clickable
 * so page-level management is uniform across the deck.
 *
 * Visuals: low-chroma zinc surface + single violet brand accent, no
 * per-row chrome (rejected `EditModeSidebar` pattern). Drag uses an
 * explicit grip handle on the thumb so the whole tile remains
 * click-to-switch.
 */
export function SlideNavRail({
  keepHandle = false,
}: {
  /**
   * Collapsed, the rail is opened from the dock's control bar. A scene with no
   * dock has no bar: there it keeps its handle.
   */
  readonly keepHandle?: boolean;
} = {}) {
  const { t } = useI18n();
  const scenes = useStageStore.use.scenes();
  const currentSceneId = useStageStore.use.currentSceneId();
  const setCurrentSceneId = useStageStore.use.setCurrentSceneId();
  const setScenes = useStageStore.use.setScenes();
  const insertSceneAfter = useStageStore.use.insertSceneAfter();
  const deleteScene = useStageStore.use.deleteScene();
  const stage = useStageStore.use.stage();
  const collapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const setCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);

  const slideCount = useMemo(() => scenes.filter((s) => s.type === 'slide').length, [scenes]);
  // For non-slide scenes (no recreate path), only allow delete if there's
  // more than one scene overall — otherwise the deck would become empty.
  const totalScenes = scenes.length;

  const onReorderIds = useCallback(
    (newOrder: string[]) => {
      const byId = new Map(scenes.map((s) => [s.id, s] as const));
      const next: Scene[] = newOrder
        .map((id) => byId.get(id))
        .filter((s): s is Scene => Boolean(s));
      if (next.length !== scenes.length) return;
      const rebalanced = next.map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 }));
      commitCourseEdit({ coalesceKey: 'page-reorder' }, () => setScenes(rebalanced));
    },
    [scenes, setScenes],
  );

  const handleActivate = useCallback(
    (sceneId: string) => {
      if (sceneId === currentSceneId) return;
      // Switching to a non-slide scene is fine — Stage will auto-exit Pro
      // mode the moment the new scene is uneditable.
      setCurrentSceneId(sceneId);
    },
    [currentSceneId, setCurrentSceneId],
  );

  const handleInsertAt = useInsertSceneAt();

  const handleDuplicate = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      const anchorIndex = scenes.findIndex((s) => s.id === sceneId);
      const newOrder = anchorIndex + 2;
      // Slide scenes get a deep clone with reseeded element IDs; non-slide
      // scenes just get a shallow id + title bump.
      const copy: Scene =
        source.type === 'slide'
          ? duplicateSlideScene(source, t('edit.nav.copySuffix'), newOrder)
          : {
              ...source,
              id: crypto.randomUUID(),
              title: `${source.title} ${t('edit.nav.copySuffix')}`,
              order: newOrder,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
      commitCourseEdit({}, () => {
        insertSceneAfter(sceneId, copy);
        setCurrentSceneId(copy.id);
      });
    },
    [insertSceneAfter, scenes, setCurrentSceneId, t],
  );

  const handleDelete = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      // Hold deck-empty guard at the rail layer; the store doesn't enforce.
      if (source.type === 'slide' && slideCount <= 1) return;
      if (totalScenes <= 1) return;
      commitCourseEdit({}, () => deleteScene(sceneId));
    },
    [deleteScene, scenes, slideCount, totalScenes],
  );

  const canDeleteAny = totalScenes > 1;
  const canDeleteSlide = slideCount > 1;

  return (
    <PageRail
      testId="slide-nav-rail"
      collapsed={collapsed}
      onCollapseChange={setCollapsed}
      keepHandle={keepHandle}
    >
      {/* List padding (p-2) as playback's scene list, so density reads the same. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide p-2 pt-0">
        <Reorder.Group
          axis="y"
          values={scenes.map((s) => s.id)}
          onReorder={onReorderIds}
          as="ol"
          className="m-0 list-none p-0"
        >
          {/* Leading zone — hover the top padding to insert
                    before the first thumb. Hits the `+ at top` use
                    case the user called out. */}
          {SCENE_CREATION_ENABLED && scenes[0] ? (
            <InsertionZone
              leading
              label={t('edit.nav.addPage')}
              slideLabel={t('edit.sceneType.slide')}
              quizLabel={t('edit.sceneType.quiz')}
              onInsert={(type) => handleInsertAt(0, type)}
            />
          ) : null}
          {scenes.map((scene, index) => (
            <Fragment key={scene.id}>
              <ThumbItem
                scene={scene}
                index={index}
                active={scene.id === currentSceneId}
                canDelete={scene.type === 'slide' ? canDeleteSlide : canDeleteAny}
                onActivate={() => handleActivate(scene.id)}
                onDuplicate={() => handleDuplicate(scene.id)}
                onDelete={() => handleDelete(scene.id)}
              />
              {SCENE_CREATION_ENABLED && (
                <InsertionZone
                  label={t('edit.nav.addPage')}
                  slideLabel={t('edit.sceneType.slide')}
                  quizLabel={t('edit.sceneType.quiz')}
                  onInsert={(type) => handleInsertAt(index + 1, type)}
                />
              )}
            </Fragment>
          ))}
        </Reorder.Group>
      </div>
    </PageRail>
  );
}
