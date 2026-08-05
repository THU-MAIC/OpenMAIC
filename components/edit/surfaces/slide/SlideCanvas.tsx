'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  EditableSlideCanvas,
  type EditIntent,
  type Selection,
  type TextAutoSizeIntent,
  type TextContentChange,
  type TextEditorController,
  type TextFormatState,
} from '@openmaic/renderer/editing';
import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SpotlightOverlay } from '@/components/slide-renderer/Editor/SpotlightOverlay';
import { LaserPointerOverlay } from '@/components/slide-renderer/Editor/LaserPointerOverlay';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { isEditorRendererEnabled } from '@/lib/config/feature-flags';
import { useCanvasStore } from '@/lib/store/canvas';
import { useResolvedSlide } from '@/components/slide-renderer/use-resolved-slide';
import {
  useEditingTextElementId,
  useResolvedSlideContent,
  useSelectedNonTextElement,
  useSlideCanvasController,
  useSyncEditingElementId,
} from './use-slide-surface';
import { AnchoredTextBar } from './AnchoredTextBar';
import { AnchoredElementBar } from './AnchoredElementBar';
import { ElementPickLayer } from './ElementPickLayer';
import { applyRendererEditIntents } from './renderer-edit-intents';
import { createRendererCanvasCommands } from './renderer-canvas-commands';
import { RendererCanvasContextMenu } from './RendererCanvasContextMenu';
import { useSlideEditSession } from './slide-edit-session';
import { useRendererCanvasShortcuts } from './use-renderer-canvas-shortcuts';
import { EDITABLE_ELEMENT_ID_PREFIX } from './renderer-element-dom';
import { resolveEditingElementId } from './editing-state';
import {
  commitRendererTextAutoSize,
  commitRendererTextChange,
  connectRendererTextController,
  mapRendererTextFormatState,
} from './renderer-text-editing';

function RendererEditorCanvas() {
  const content = useResolvedSlideContent();
  const resolvedSlide = useResolvedSlide(content.canvas);
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const hiddenElementIds = useCanvasStore.use.hiddenElementIdList();
  const pickTarget = useCanvasStore.use.pickTarget();
  const disableHotkeys = useCanvasStore.use.disableHotkeys();
  const editingElementId = useCanvasStore.use.editingElementId();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setEditingElementId = useCanvasStore.use.setEditingElementId();
  const setRichtextAttrs = useCanvasStore.use.setRichtextAttrs();
  const setDisableHotkeysState = useCanvasStore.use.setDisableHotkeysState();
  const detachTextControllerRef = useRef<(() => void) | null>(null);
  const activeEditingElementId = useMemo(
    () => resolveEditingElementId(activeElementIds, content.canvas.elements, editingElementId),
    [activeElementIds, content.canvas.elements, editingElementId],
  );

  const selection = useMemo<Selection>(
    () => ({
      elementIds: activeElementIds,
      primaryId: activeElementIds[0],
      editingId: activeEditingElementId || undefined,
    }),
    [activeEditingElementId, activeElementIds],
  );

  const handleSelectionChange = useCallback(
    (next: Selection) => {
      setActiveElementIdList([...next.elementIds]);
      setEditingElementId(next.editingId ?? '');
    },
    [setActiveElementIdList, setEditingElementId],
  );

  const handleElementsChange = useCallback(
    (intents: EditIntent[]) => {
      const base = useSlideEditSession.getState().history?.present ?? content;
      const next = applyRendererEditIntents(base, intents);
      if (next === base) return;
      useSlideEditSession.getState().commitContent(next, true);
    },
    [content],
  );

  const handleTextContentChange = useCallback(
    (change: TextContentChange) => commitRendererTextChange(content, change),
    [content],
  );
  const handleTextAutoSize = useCallback(
    (intent: TextAutoSizeIntent) => commitRendererTextAutoSize(content, intent),
    [content],
  );
  const handleTextFormatChange = useCallback(
    (_elementId: string, state: TextFormatState) => {
      setRichtextAttrs(mapRendererTextFormatState(state));
    },
    [setRichtextAttrs],
  );
  const handleTextEditorChange = useCallback((controller: TextEditorController | null) => {
    detachTextControllerRef.current?.();
    detachTextControllerRef.current = controller ? connectRendererTextController(controller) : null;
  }, []);
  const handleTextFocusChange = useCallback(
    (focused: boolean) => setDisableHotkeysState(focused),
    [setDisableHotkeysState],
  );
  useEffect(
    () => () => {
      detachTextControllerRef.current?.();
      detachTextControllerRef.current = null;
      setDisableHotkeysState(false);
    },
    [setDisableHotkeysState],
  );

  const commands = useMemo(
    () =>
      createRendererCanvasCommands({
        content,
        selection,
        hiddenElementIds,
        onIntents: handleElementsChange,
        onSelectionChange: handleSelectionChange,
      }),
    [content, handleElementsChange, handleSelectionChange, hiddenElementIds, selection],
  );
  useRendererCanvasShortcuts(commands, {
    enabled: !disableHotkeys,
    pickActive: Boolean(pickTarget),
  });

  return (
    <RendererCanvasContextMenu
      content={content}
      selection={selection}
      commands={commands}
      onSelectionChange={handleSelectionChange}
    >
      <EditableSlideCanvas
        slide={resolvedSlide}
        elementIdPrefix={EDITABLE_ELEMENT_ID_PREFIX}
        hiddenElementIds={hiddenElementIds}
        snapping
        selection={selection}
        onSelectionChange={handleSelectionChange}
        onElementsChange={handleElementsChange}
        onTextContentChange={handleTextContentChange}
        onTextAutoSize={handleTextAutoSize}
        onTextFormatChange={handleTextFormatChange}
        onTextEditorChange={handleTextEditorChange}
        onTextFocusChange={handleTextFocusChange}
      />
    </RendererCanvasContextMenu>
  );
}

/**
 * The slide surface's canvas. Reuses the unmodified slide renderer
 * (`components/slide-renderer/Editor/Canvas`) and wraps it in a
 * surface-controlled scene context so every renderer commit funnels
 * through the slide-edit-session which auto-saves it back to the
 * canonical stage store (no staging, no "restore unsaved" prompt).
 *
 * It also owns the selection-anchored chrome: it derives the selected element,
 * mirrors a selected text element into the canvas store's `editingElementId`
 * (which the renderer reads to draw a clean frame), and renders the anchored
 * bars — the format bar for text, a type-aware element bar (z-order + delete,
 * plus replace/crop/flip for images) for every other element type.
 * At most one bar is open at a time (single selection).
 */
export function SlideCanvas() {
  const { controller, gestureProps } = useSlideCanvasController();
  const useRendererEditor = isEditorRendererEnabled();
  const requestedEditingElementId = useCanvasStore.use.editingElementId();
  const editingElementId = useEditingTextElementId(
    useRendererEditor ? requestedEditingElementId : undefined,
  );
  const nonTextElement = useSelectedNonTextElement();
  useSyncEditingElementId(editingElementId, !useRendererEditor);

  // Esc disarms in-flight insert mode. Read via getState so the listener mounts
  // once; checking inside the handler keeps us inert when nothing is armed.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const cs = useCanvasStore.getState();
      if (cs.creatingElement) cs.setCreatingElement(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    // gestureProps marks pointer-gesture windows so a renderer commit is
    // classified as a real user edit vs ResizeObserver text normalization
    // (which fires with no gesture in flight). The padded studio frame
    // around the canvas now lives in EditShell.Frame so non-slide scenes
    // (rendered via SceneRenderer in read-only mode) share the exact
    // same canvas bounding rect — switching scene type no longer
    // resizes / reflows the frame, which used to cause the slide↔
    // interactive layout jump.
    <div className="relative h-full w-full" {...gestureProps}>
      <SceneProvider controller={controller}>
        {useRendererEditor ? <RendererEditorCanvas /> : <Canvas />}
        {/* Same spotlight + laser effects as playback, retargeted to the
            editor's element ids — driven by useCanvasStore.setSpotlight /
            setLaser (e.g. from the ActionsBar cue-badge hover). The laser cue
            replays as a laser pointer, the spotlight cue as a spotlight. */}
        <SpotlightOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
        <LaserPointerOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
      </SceneProvider>
      <AnchoredTextBar editingElementId={editingElementId} />
      <AnchoredElementBar element={nonTextElement} />
      {/* Canvas-side element picker for the timeline's element-bound cues. */}
      <ElementPickLayer />
    </div>
  );
}
