'use client';

import { useCallback, useMemo } from 'react';
import type { Selection } from '@openmaic/editor/react';
import {
  EditableSlideCanvasWithUI,
  type EditorHostCapabilities,
  type EditorTranslate,
} from '@openmaic/editor/ui';
import type { EditorTransaction } from '@openmaic/editor/core';
import { useResolvedSlide } from '@/components/slide-renderer/use-resolved-slide';
import { createElementId } from '@/lib/edit/element-id';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSyncCanvasViewportFromSlide } from '@/lib/store/sync-canvas-viewport';
import { EDITABLE_ELEMENT_ID_PREFIX } from './renderer-element-dom';
import { useSlideEditSession } from './slide-edit-session';
import { useResolvedSlideContent } from './use-slide-surface';

export function RendererEditorCanvas() {
  useSyncCanvasViewportFromSlide();
  const { locale, t } = useI18n();
  const content = useResolvedSlideContent();
  const slide = useResolvedSlide(content.canvas);
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const hiddenElementIds = useCanvasStore.use.hiddenElementIdList();
  const editingElementId = useCanvasStore.use.editingElementId();
  const pickTarget = useCanvasStore.use.pickTarget();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setEditingElementId = useCanvasStore.use.setEditingElementId();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();
  const sceneId = useSlideEditSession.getState().sceneId;

  const selection = useMemo<Selection>(() => {
    const editingId =
      editingElementId &&
      activeElementIds.includes(editingElementId) &&
      content.canvas.elements.some((element) => element.id === editingElementId)
        ? editingElementId
        : undefined;
    return {
      elementIds: activeElementIds,
      primaryId: activeElementIds[0],
      editingId,
    };
  }, [activeElementIds, content.canvas.elements, editingElementId]);

  const handleSelectionChange = useCallback(
    (next: Selection) => {
      if (!sceneId || useSlideEditSession.getState().sceneId !== sceneId) return;
      setActiveElementIdList([...next.elementIds]);
      setEditingElementId(next.editingId ?? '');
    },
    [sceneId, setActiveElementIdList, setEditingElementId],
  );

  const applyTransaction = useCallback(
    (transaction: EditorTransaction) => {
      if (!sceneId) return;
      useSlideEditSession.getState().applyTransactionForScene(sceneId, transaction);
    },
    [sceneId],
  );

  const translateEditor = useCallback<EditorTranslate>(
    (key, params, defaultMessage) =>
      t(`edit.${key}`, { ...(params ?? {}), defaultValue: defaultMessage }),
    [t],
  );

  const host = useMemo<EditorHostCapabilities>(
    () => ({
      locale,
      translate: translateEditor,
      createElementId,
      shortcutsEnabled: !pickTarget,
    }),
    [locale, pickTarget, translateEditor],
  );

  return (
    <EditableSlideCanvasWithUI
      slide={slide}
      documentSlide={content.canvas}
      host={host}
      selection={selection}
      onSelectionChange={handleSelectionChange}
      onTransaction={applyTransaction}
      onScaleChange={setCanvasScale}
      elementIdPrefix={EDITABLE_ELEMENT_ID_PREFIX}
      hiddenElementIds={hiddenElementIds}
      insertToolbarPlacement="top"
      snapping
    />
  );
}
