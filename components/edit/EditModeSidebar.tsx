'use client';

import { useCallback } from 'react';
import { ChevronDown, ChevronUp, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ThumbnailSlide } from '@/components/slide-renderer/components/ThumbnailSlide';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import { reorderScene } from '@/lib/edit/reorder-scenes';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';

interface EditModeSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect: (sceneId: string) => void;
}

/**
 * Edit-mode sidebar — distinct from playback's SceneSidebar.
 *
 * - Lists only real scenes (no virtual completion page)
 * - Per-page actions: select / delete / move up / move down
 * - Footer: "+ Add slide" creates a new blank slide and selects it
 * - Collapsible via top-right chevron; collapsed state shows a slim strip
 */
export function EditModeSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
}: EditModeSidebarProps) {
  const { t } = useI18n();
  const stage = useStageStore((s) => s.stage);
  const scenes = useStageStore((s) => s.scenes);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const setScenes = useStageStore((s) => s.setScenes);
  const addScene = useStageStore((s) => s.addScene);
  const deleteScene = useStageStore((s) => s.deleteScene);
  const setCurrentSceneId = useStageStore((s) => s.setCurrentSceneId);

  const handleMove = useCallback(
    (sceneId: string, direction: 'up' | 'down') => {
      const reordered = reorderScene(scenes, sceneId, direction);
      if (reordered) setScenes(reordered);
    },
    [scenes, setScenes],
  );

  const handleAddSlide = useCallback(() => {
    if (!stage) return;
    const newId = nanoid();
    const lastOrder = scenes.length > 0 ? Math.max(...scenes.map((s) => s.order)) : 0;
    const newScene: Scene = {
      id: newId,
      stageId: stage.id,
      type: 'slide',
      title: t('edit.sidebar.newSlide'),
      order: lastOrder + 1,
      content: { type: 'slide', canvas: createDefaultSlide(`slide-${newId}`) },
    };
    addScene(newScene);
    setCurrentSceneId(newId);
  }, [addScene, scenes, setCurrentSceneId, stage, t]);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-zinc-200/60 bg-white/80 py-3 dark:border-zinc-800/60 dark:bg-zinc-950/60">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              onClick={() => onCollapseChange(false)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('edit.sidebar.expand')}</TooltipContent>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200/60 bg-white/80 dark:border-zinc-800/60 dark:bg-zinc-950/60">
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-3 py-2 dark:border-zinc-800/60">
        <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          {t('edit.sidebar.pages')} · {scenes.length}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-7 w-7 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              onClick={() => onCollapseChange(true)}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('edit.sidebar.collapse')}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1.5">
          {scenes.map((scene, index) => (
            <SidebarItem
              key={scene.id}
              scene={scene}
              index={index}
              total={scenes.length}
              isCurrent={scene.id === currentSceneId}
              onSelect={() => {
                setCurrentSceneId(scene.id);
                onSceneSelect(scene.id);
              }}
              onMoveUp={() => handleMove(scene.id, 'up')}
              onMoveDown={() => handleMove(scene.id, 'down')}
              onDelete={() => deleteScene(scene.id)}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-zinc-200/60 p-2 dark:border-zinc-800/60">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-center gap-1.5 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          onClick={handleAddSlide}
          disabled={!stage}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('edit.sidebar.addSlide')}
        </Button>
      </div>
    </aside>
  );
}

function SidebarItem({
  scene,
  index,
  total,
  isCurrent,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  readonly scene: Scene;
  readonly index: number;
  readonly total: number;
  readonly isCurrent: boolean;
  readonly onSelect: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  const slideCanvas =
    scene.type === 'slide' && scene.content.type === 'slide' ? scene.content.canvas : null;

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 rounded-xl border p-1.5 transition-colors',
        isCurrent
          ? 'border-violet-300 bg-violet-50/70 dark:border-violet-500/60 dark:bg-violet-950/40'
          : 'border-transparent hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40',
      )}
    >
      <span className="w-4 shrink-0 text-center text-[10px] font-medium text-zinc-400 tabular-nums">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex aspect-video min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md text-xs',
          slideCanvas
            ? 'bg-white shadow-sm dark:bg-zinc-900'
            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
        )}
        title={scene.title}
      >
        {slideCanvas ? (
          <ThumbnailSlide
            slide={slideCanvas}
            size={140}
            viewportSize={slideCanvas.viewportSize ?? 1000}
            viewportRatio={slideCanvas.viewportRatio ?? 0.5625}
          />
        ) : (
          <span className="px-2 truncate text-[11px] uppercase tracking-wide">{scene.type}</span>
        )}
      </button>

      {/* Hover-revealed action column */}
      <div className="flex flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={index === 0}
              onClick={onMoveUp}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('edit.sidebar.moveUp')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={index === total - 1}
              onClick={onMoveDown}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('edit.sidebar.moveDown')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDelete}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-950/50 dark:hover:text-rose-400"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('edit.sidebar.delete')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
