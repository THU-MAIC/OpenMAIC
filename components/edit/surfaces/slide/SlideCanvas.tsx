'use client';

import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type { PPTImageElement, PPTTextElement } from '@openmaic/dsl';
import type {
  EditIntent,
  Selection,
  TextCreateRect,
  TextAutoSizeIntent,
  TextContentChange,
} from '@openmaic/renderer/editing';
import { EditableSlideCanvasWithUI } from '@openmaic/renderer/editing-ui';
import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SpotlightOverlay } from '@/components/slide-renderer/Editor/SpotlightOverlay';
import { LaserPointerOverlay } from '@/components/slide-renderer/Editor/LaserPointerOverlay';
import { FONTS } from '@/configs/font';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { isEditorRendererEnabled } from '@/lib/config/feature-flags';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import { useResolvedSlide } from '@/components/slide-renderer/use-resolved-slide';
import { ImageClipHandler } from '@/components/slide-renderer/components/element/ImageElement/ImageClipHandler';
import { useClipImage } from '@/components/slide-renderer/components/element/ImageElement/useClipImage';
import type { ImageClipedEmitData } from '@/lib/types/edit';
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
import { createElementId } from '@/lib/edit/element-id';
import { resolveEditingElementId } from './editing-state';
import { commitRendererTextAutoSize, commitRendererTextChange } from './renderer-text-editing';

function RendererEditorImageContent({
  element,
  defaultContent,
  clipping,
  onClip,
}: {
  readonly element: PPTImageElement;
  readonly defaultContent: ReactNode;
  readonly clipping: boolean;
  readonly onClip: (data: ImageClipedEmitData | null) => void;
}) {
  const { clipShape } = useClipImage(element);
  if (!clipping) return defaultContent;
  return (
    <ImageClipHandler
      src={element.src}
      clipData={element.clip}
      clipPath={clipShape.style}
      width={element.width}
      height={element.height}
      top={element.top}
      left={element.left}
      rotate={element.rotate}
      onClip={onClip}
    />
  );
}

function RendererEditorCanvas() {
  const { locale, t } = useI18n();
  const content = useResolvedSlideContent();
  const resolvedSlide = useResolvedSlide(content.canvas, {
    preserveUnresolvedImagePlaceholders: true,
  });
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const hiddenElementIds = useCanvasStore.use.hiddenElementIdList();
  const pickTarget = useCanvasStore.use.pickTarget();
  const disableHotkeys = useCanvasStore.use.disableHotkeys();
  const editingElementId = useCanvasStore.use.editingElementId();
  const creatingElement = useCanvasStore.use.creatingElement();
  const clipingImageElementId = useCanvasStore.use.clipingImageElementId();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setEditingElementId = useCanvasStore.use.setEditingElementId();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();
  const setDisableHotkeysState = useCanvasStore.use.setDisableHotkeysState();
  const toolbarFonts = useMemo(
    () =>
      FONTS.map((font) => ({
        value: font.value,
        label: font.labelKey ? t(font.labelKey) : font.label,
      })),
    [t],
  );
  const activeEditingElementId = useMemo(
    () =>
      resolveEditingElementId(activeElementIds, content.canvas.elements, editingElementId, [
        'text',
        'shape',
        'image',
      ]),
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
  const handleTextFocusChange = useCallback(
    (focused: boolean) => setDisableHotkeysState(focused),
    [setDisableHotkeysState],
  );
  useEffect(() => () => setDisableHotkeysState(false), [setDisableHotkeysState]);

  const handleTextCreate = useCallback(
    (rect: TextCreateRect) => {
      const id = createElementId('text');
      const element: PPTTextElement = {
        id,
        type: 'text',
        ...rect,
        rotate: 0,
        content: '<p style="text-align: center"><br></p>',
        defaultFontName: '',
        defaultColor: '#333',
      };
      handleElementsChange([{ type: 'element.add', element }]);
      setCreatingElement(null);
      setActiveElementIdList([id]);
      setEditingElementId(id);
    },
    [handleElementsChange, setActiveElementIdList, setCreatingElement, setEditingElementId],
  );

  const handleImageClip = useCallback(
    (element: PPTImageElement, data: ImageClipedEmitData | null) => {
      useCanvasStore.getState().setClipingImageElementId('');
      useCanvasStore.getState().setEditingElementId('');
      if (!data) return;

      const originClip = element.clip ?? {
        shape: 'rect' as const,
        range: [
          [0, 0],
          [100, 100],
        ] as [[number, number], [number, number]],
      };
      const { range, position } = data;
      const left = element.left + position.left;
      const top = element.top + position.top;
      const width = element.width + position.width;
      const height = element.height + position.height;
      let centerOffsetX = 0;
      let centerOffsetY = 0;
      if (element.rotate) {
        const centerX = left + width / 2 - (element.left + element.width / 2);
        const centerY = -(top + height / 2 - (element.top + element.height / 2));
        const radian = (-element.rotate * Math.PI) / 180;
        const rotatedCenterX = centerX * Math.cos(radian) - centerY * Math.sin(radian);
        const rotatedCenterY = centerX * Math.sin(radian) + centerY * Math.cos(radian);
        centerOffsetX = rotatedCenterX - centerX;
        centerOffsetY = -(rotatedCenterY - centerY);
      }
      handleElementsChange([
        {
          type: 'element.update',
          id: element.id,
          props: {
            clip: { ...originClip, range },
            left: left + centerOffsetX,
            top: top + centerOffsetY,
            width,
            height,
          },
        },
      ]);
    },
    [handleElementsChange],
  );
  const renderEditorImage = useCallback(
    (element: PPTImageElement, _resolvedSrc: string, defaultContent: ReactNode) => (
      <RendererEditorImageContent
        element={element}
        defaultContent={defaultContent}
        clipping={clipingImageElementId === element.id}
        onClip={(data) => handleImageClip(element, data)}
      />
    ),
    [clipingImageElementId, handleImageClip],
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
      <EditableSlideCanvasWithUI
        slide={resolvedSlide}
        onScaleChange={setCanvasScale}
        elementIdPrefix={EDITABLE_ELEMENT_ID_PREFIX}
        hiddenElementIds={hiddenElementIds}
        snapping
        selection={selection}
        onSelectionChange={handleSelectionChange}
        onElementsChange={handleElementsChange}
        onTextContentChange={handleTextContentChange}
        onTextAutoSize={handleTextAutoSize}
        onTextFocusChange={handleTextFocusChange}
        creatingText={creatingElement?.type === 'text'}
        onTextCreate={handleTextCreate}
        renderImage={renderEditorImage}
        shapePathFormulas={SHAPE_PATH_FORMULAS}
        textToolbar={{
          locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
          fonts: toolbarFonts,
        }}
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
      {!useRendererEditor && <AnchoredTextBar editingElementId={editingElementId} />}
      <AnchoredElementBar element={nonTextElement} />
      {/* Canvas-side element picker for the timeline's element-bound cues. */}
      <ElementPickLayer />
    </div>
  );
}
