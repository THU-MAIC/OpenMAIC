'use client';

import { useCallback, useMemo } from 'react';
import type { Selection } from '@openmaic/editor/react';
import { EditableSlideCanvasWithUI, type EditorHostCapabilities } from '@openmaic/editor/ui';
import type { EditorTransaction } from '@openmaic/editor/core';
import { useResolvedSlide } from '@/components/slide-renderer/use-resolved-slide';
import { createElementId } from '@/lib/edit/element-id';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import { EDITABLE_ELEMENT_ID_PREFIX } from './renderer-element-dom';
import { useSlideEditSession } from './slide-edit-session';
import { useResolvedSlideContent } from './use-slide-surface';

export function RendererEditorCanvas() {
  const { locale } = useI18n();
  const content = useResolvedSlideContent();
  const slide = useResolvedSlide(content.canvas);
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const hiddenElementIds = useCanvasStore.use.hiddenElementIdList();
  const editingElementId = useCanvasStore.use.editingElementId();
  const pickTarget = useCanvasStore.use.pickTarget();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setEditingElementId = useCanvasStore.use.setEditingElementId();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();

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
      setActiveElementIdList([...next.elementIds]);
      setEditingElementId(next.editingId ?? '');
    },
    [setActiveElementIdList, setEditingElementId],
  );

  const applyTransaction = useCallback((transaction: EditorTransaction) => {
    useSlideEditSession.getState().applyTransaction(transaction);
  }, []);

  const host = useMemo<EditorHostCapabilities>(
    () => ({
      locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
      createElementId,
      shortcutsEnabled: !pickTarget,
    }),
    [locale, pickTarget],
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
      snapping
    />
  );
}
