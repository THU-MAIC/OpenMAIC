'use client';

import { createElement, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type {
  ChartType,
  PPTImageElement,
  PPTLineElement,
  PPTTextElement,
  PPTVideoElement,
} from '@openmaic/dsl';
import type {
  EditIntent,
  LineCreateGeometry,
  Selection,
  TextCreateRect,
  TextAutoSizeIntent,
  TextContentChange,
  TableCellChange,
} from '@openmaic/renderer/editing';
import {
  ChartInsertPicker,
  EditableSlideCanvasWithUI,
  TableInsertPicker,
  type InsertToolbarOptions,
  type LatexEditorResult,
  type VideoInsertResult,
} from '@openmaic/renderer/editing-ui';
import { BarChart3, Image as ImageIcon, Minus, PaintBucket, Table2, Type } from 'lucide-react';
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
  insertChartElement,
  insertImageElement,
  insertTableElement,
  useResolvedSlideContent,
  useSelectedNonTextElement,
  useSlideCanvasController,
  useSyncEditingElementId,
} from './use-slide-surface';
import { ImagePicker } from './ImagePicker';
import { BackgroundControl } from './BackgroundControl';
import { LinePresetPicker } from './LinePresetPicker';
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
import { createDefaultLatexElement } from '@/lib/edit/slide-edit-elements';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { resolveEditingElementId } from './editing-state';
import { commitRendererTextAutoSize, commitRendererTextChange } from './renderer-text-editing';
import { commitRendererTableCellChange } from './renderer-table-editing';
import type { LinePoolItem } from '@/configs/lines';

const DEFAULT_LINE_PRESET: LinePoolItem = {
  path: 'M 0 0 L 20 20',
  style: 'solid',
  points: ['', ''],
};

function linePresetControls(
  preset: LinePoolItem,
  midpoint: [number, number],
): Partial<PPTLineElement> {
  if (preset.isCubic) return { cubic: [midpoint, midpoint] };
  if (preset.isCurve) return { curve: midpoint };
  if (preset.isBroken2) return { broken2: midpoint };
  if (preset.isBroken) return { broken: midpoint };
  return {};
}

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

/**
 * Keep the editor preview inert. Presentation playback owns all media state,
 * so selection and resize gestures never compete with native video controls.
 */
function RendererEditorVideoContent({ element }: { readonly element: PPTVideoElement }) {
  const playableSrc = element.src && !isMediaPlaceholder(element.src) ? element.src : undefined;

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded bg-black/10"
      data-renderer-editor-video-preview=""
    >
      {element.poster ? (
        <img
          className="h-full w-full"
          style={{ objectFit: 'contain' }}
          src={element.poster}
          alt=""
          draggable={false}
        />
      ) : playableSrc ? (
        <video
          className="h-full w-full"
          style={{ objectFit: 'contain' }}
          src={playableSrc}
          muted
          playsInline
          preload="metadata"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/50">
          <svg className="ml-0.5 h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      </div>
    </div>
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
        'table',
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
  const handleTableCellChange = useCallback(
    (change: TableCellChange) => commitRendererTableCellChange(content, change),
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

  const handleLatexInsert = useCallback(
    (result: LatexEditorResult) => {
      const id = createElementId('latex');
      handleElementsChange([{ type: 'element.add', element: createDefaultLatexElement(id, result) }]);
      setActiveElementIdList([id]);
      setEditingElementId('');
    },
    [handleElementsChange, setActiveElementIdList, setEditingElementId],
  );

  const handleLatexUpdate = useCallback(
    (elementId: string, result: LatexEditorResult) => {
      handleElementsChange([
        {
          type: 'element.update',
          id: elementId,
          props: {
            latex: result.latex,
            html: result.html,
            width: result.width,
            height: result.height,
          },
        },
      ]);
    },
    [handleElementsChange],
  );

  const handleLatexReorder = useCallback(
    (elementId: string, command: 'front' | 'back') => {
      handleElementsChange([{ type: 'element.reorder', id: elementId, command }]);
    },
    [handleElementsChange],
  );

  const handleLatexDelete = useCallback(
    (elementId: string) => {
      handleElementsChange([{ type: 'element.delete', ids: [elementId] }]);
      setActiveElementIdList([]);
      setEditingElementId('');
    },
    [handleElementsChange, setActiveElementIdList, setEditingElementId],
  );

  const handleVideoPosterChange = useCallback(
    (elementId: string, poster: string) => {
      handleElementsChange([{ type: 'element.update', id: elementId, props: { poster } }]);
    },
    [handleElementsChange],
  );

  const handleVideoInsert = useCallback(
    ({ src, ext }: VideoInsertResult) => {
      const id = createElementId('video');
      const element: PPTVideoElement = {
        id,
        type: 'video',
        left: 180,
        top: 140,
        width: 360,
        height: 203,
        rotate: 0,
        src,
        autoplay: false,
        ...(ext ? { ext } : {}),
      };
      handleElementsChange([{ type: 'element.add', element }]);
      setActiveElementIdList([id]);
      setEditingElementId('');
    },
    [handleElementsChange, setActiveElementIdList, setEditingElementId],
  );

  const handleVideoReorder = useCallback(
    (elementId: string, command: 'front' | 'back') => {
      handleElementsChange([{ type: 'element.reorder', id: elementId, command }]);
    },
    [handleElementsChange],
  );

  const handleVideoDelete = useCallback(
    (elementId: string) => {
      handleElementsChange([{ type: 'element.delete', ids: [elementId] }]);
      setActiveElementIdList([]);
      setEditingElementId('');
    },
    [handleElementsChange, setActiveElementIdList, setEditingElementId],
  );

  const handleLineCreate = useCallback(
    (geometry: LineCreateGeometry) => {
      const id = createElementId('line');
      const [startX, startY] = geometry.start;
      const [endX, endY] = geometry.end;
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const preset =
        creatingElement?.type === 'line'
          ? creatingElement.data
          : DEFAULT_LINE_PRESET;
      const start: [number, number] = [startX - left, startY - top];
      const end: [number, number] = [endX - left, endY - top];
      const midpoint: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      const element: PPTLineElement = {
        id,
        type: 'line',
        left,
        top,
        width: 2,
        start,
        end,
        style: preset.style,
        color: '#333333',
        points: preset.points,
        ...linePresetControls(preset, midpoint),
      };
      handleElementsChange([{ type: 'element.add', element }]);
      setCreatingElement(null);
      setActiveElementIdList([id]);
      setEditingElementId('');
    },
    [
      creatingElement,
      handleElementsChange,
      setActiveElementIdList,
      setCreatingElement,
      setEditingElementId,
    ],
  );
  const cancelLineCreate = useCallback(() => setCreatingElement(null), [setCreatingElement]);

  const insertToolbar = useMemo<InsertToolbarOptions>(
    () => {
      const armText = () =>
        setCreatingElement(creatingElement?.type === 'text' ? null : { type: 'text' });
      const armLine = (preset: LinePoolItem) =>
        setCreatingElement(
          creatingElement?.type === 'line' ? null : { type: 'line', data: preset },
        );

      return {
        items: [
          {
            id: 'insert-text',
            label: t('edit.insert.textBox'),
            tooltip: t('edit.insert.textBox'),
            icon: createElement(Type, { 'aria-hidden': true }),
            active: creatingElement?.type === 'text',
            onInvoke: armText,
          },
          {
            id: 'insert-image',
            label: t('edit.insert.image'),
            tooltip: t('edit.insert.image'),
            icon: createElement(ImageIcon, { 'aria-hidden': true }),
            renderPopover: ({ close }) =>
              createElement(ImagePicker, {
                onPick: (src: string) => {
                  insertImageElement(src);
                  close();
                },
              }),
          },
          {
            id: 'insert-table',
            label: t('edit.insert.table'),
            tooltip: t('edit.insert.table'),
            icon: createElement(Table2, { 'aria-hidden': true }),
            renderPopover: ({ close }) =>
              createElement(TableInsertPicker, {
                getLabel: (rows: number, columns: number) =>
                  t('edit.insert.tableDimensions', { rows, columns }),
                onPick: (rows: number, columns: number) => {
                  insertTableElement(rows, columns);
                  close();
                },
              }),
          },
          {
            id: 'insert-chart',
            label: t('edit.insert.chart'),
            tooltip: t('edit.insert.chart'),
            icon: createElement(BarChart3, { 'aria-hidden': true }),
            renderPopover: ({ close }) =>
              createElement(ChartInsertPicker, {
                options: [
                  { type: 'bar' as ChartType, label: t('edit.insert.chartBar') },
                  { type: 'line' as ChartType, label: t('edit.insert.chartLine') },
                  { type: 'pie' as ChartType, label: t('edit.insert.chartPie') },
                ],
                onPick: (chartType: ChartType) => {
                  insertChartElement(chartType);
                  close();
                },
              }),
          },
          {
            id: 'insert-line',
            label: t('edit.insert.line'),
            tooltip: t('edit.insert.line'),
            icon: createElement(Minus, { 'aria-hidden': true }),
            active: creatingElement?.type === 'line',
            renderPopover: ({ close }) =>
              createElement(LinePresetPicker, {
                onPick: (preset: LinePoolItem) => {
                  armLine(preset);
                  close();
                },
              }),
          },
          {
            id: 'slide-background',
            label: t('edit.background.label'),
            tooltip: t('edit.background.label'),
            icon: createElement(PaintBucket, { 'aria-hidden': true }),
            renderPopover: () => createElement(BackgroundControl),
          },
        ],
      };
    },
    [creatingElement?.type, setCreatingElement, t],
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
  const renderEditorVideo = useCallback(
    (element: PPTVideoElement) => <RendererEditorVideoContent element={element} />,
    [],
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
        onTableCellChange={handleTableCellChange}
        tableEditMaskLabel={t('edit.table.doubleClickToEdit')}
        creatingText={creatingElement?.type === 'text'}
        onTextCreate={handleTextCreate}
        creatingLine={creatingElement?.type === 'line'}
        onLineCreate={handleLineCreate}
        onLineCreateCancel={cancelLineCreate}
        renderImage={renderEditorImage}
        renderVideo={renderEditorVideo}
        videoInteractive={false}
        shapePathFormulas={SHAPE_PATH_FORMULAS}
        textToolbar={{
          locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
          fonts: toolbarFonts,
        }}
        lineToolbar={{ locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' }}
        insertToolbar={insertToolbar}
        latexEditor={{
          labels: {
            toolbar: t('edit.latex.toolbar'),
            insertFormula: t('edit.insert.formula'),
            editFormula: t('edit.latex.editFormula'),
            bringToFront: t('edit.zorder.toFront'),
            sendToBack: t('edit.zorder.toBack'),
            delete: t('edit.delete'),
            dialog: t('edit.latex.dialog'),
            source: t('edit.latex.source'),
            preview: t('edit.latex.preview'),
            symbols: t('edit.latex.symbols'),
            presets: t('edit.latex.presets'),
            invalidSource: t('edit.latex.invalidSource'),
            cancel: t('common.cancel'),
            confirm: t('common.confirm'),
          },
          onInsert: handleLatexInsert,
          onUpdate: handleLatexUpdate,
          onBringToFront: (elementId) => handleLatexReorder(elementId, 'front'),
          onSendToBack: (elementId) => handleLatexReorder(elementId, 'back'),
          onDelete: handleLatexDelete,
        }}
        videoEditor={{
          labels: {
            toolbar: t('edit.video.toolbar'),
            poster: t('edit.video.poster'),
            bringToFront: t('edit.zorder.toFront'),
            sendToBack: t('edit.zorder.toBack'),
            delete: t('edit.delete'),
          },
          renderPosterPicker: ({ onPick }) => <ImagePicker onPick={onPick} />,
          onPosterChange: handleVideoPosterChange,
          onBringToFront: (elementId) => handleVideoReorder(elementId, 'front'),
          onSendToBack: (elementId) => handleVideoReorder(elementId, 'back'),
          onDelete: handleVideoDelete,
        }}
        videoInsert={{
          labels: {
            insertVideo: t('edit.insert.video'),
            videoDrop: t('edit.insert.videoDrop'),
            videoOr: t('edit.insert.videoOr'),
            videoUrlPlaceholder: t('edit.insert.videoUrlPlaceholder'),
            videoInsert: t('edit.insert.videoInsert'),
          },
          onInsert: handleVideoInsert,
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
      <AnchoredElementBar
        element={
          useRendererEditor &&
          (nonTextElement?.type === 'line' ||
            nonTextElement?.type === 'latex' ||
            nonTextElement?.type === 'video')
            ? null
            : nonTextElement
        }
      />
      {/* Canvas-side element picker for the timeline's element-bound cues. */}
      <ElementPickLayer />
    </div>
  );
}
