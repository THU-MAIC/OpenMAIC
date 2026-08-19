'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PPTElement, PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';

import { SlideCanvas, useViewportSize } from '@openmaic/renderer';
import { SelectionOverlay } from './handles/SelectionOverlay';
import { LineHandles } from './handles/LineHandles';
import { ResizeHandles } from './handles/ResizeHandles';
import { RotateHandle } from './handles/RotateHandle';
import { ShapeKeypointHandles } from './handles/ShapeKeypointHandles';
import { MarqueeBox } from './handles/MarqueeBox';
import { AlignmentGuides } from './handles/AlignmentGuides';
import { ElementInteractionLayer } from './layers/ElementInteractionLayer';
import { useEditGesture } from './useEditGesture';
import { useLineHandleGesture } from './useLineHandleGesture';
import { useMarqueeGesture } from './useMarqueeGesture';
import { useResizeGesture } from './useResizeGesture';
import { useRotateGesture } from './useRotateGesture';
import { useShapeKeypointGesture } from './useShapeKeypointGesture';
import { useTextCreateGesture } from './useTextCreateGesture';
import { useLineCreateGesture } from './useLineCreateGesture';
import { getLineSnapPoints } from './core/line-drag';
import { getResizeHandles } from './core/resize';
import { canRotate } from './core/rotate';
import { RendererTextEditor } from './text/RendererTextEditor';
import { RendererShapeLabelEditor } from './shape/RendererShapeLabelEditor';
import {
  RendererTableEditor,
  TableEditMask,
  type RendererTableEditorController,
} from './table/RendererTableEditor';
import { TextAutoSize, type TextAutoSizeController } from './text/TextAutoSize';
import { isSemanticallyEmptyText } from './text/richText';
import { EDITOR_REACT_STYLES } from './styles';
import type { TextEditorController } from './text/types';
import { EMPTY_SELECTION, type EditableSlideCanvasProps } from './types';

/**
 * EditableSlideCanvas — the renderer v2 editing surface. It renders the
 * controlled document through the v1 read-only {@link SlideCanvas} (whose
 * render path is left untouched) and layers its own interaction surface on top:
 * a per-element hit layer that arms drag/click gestures, and a
 * {@link SelectionOverlay} driven by the controlled `selection`.
 *
 * Gestures are owned by {@link useEditGesture}: pointer-down + drag produces a
 * live working copy for 60fps feedback and, on pointer-up past a small
 * threshold, emits exactly one `element.update` intent via `onElementsChange`;
 * a click with no movement reports selection via `onSelectionChange` only.
 * Alignment guides are computed but not drawn in this PR.
 *
 * The interaction layer is a sibling overlay (same origin, positions scaled by
 * `canvasScale`) so the v1 fill/render contract is preserved unmodified. When
 * `scale` is omitted the canvas auto-fits: the overlay reads the SAME
 * `fitScale` SlideCanvas uses (both measure the same box — see the inner
 * wrapper below), so overlay and elements stay aligned at auto-fit.
 * `renderImage`/`renderVideo`/`elementIdPrefix`/`className`/`style` pass through.
 *
 * The interaction hit layer is only mounted when a mutation/selection callback
 * is provided; with neither, the canvas renders read-only (no pointer-capturing
 * hit targets), matching the Stage-0 inert-without-callbacks contract.
 */
export function EditableSlideCanvas(props: EditableSlideCanvasProps) {
  const {
    slide,
    onScaleChange,
    renderImage,
    renderVideo,
    renderShapeLabel,
    videoInteractive,
    elementIdPrefix,
    hiddenElementIds,
    className,
    style,
    selection,
    onSelectionChange,
    onElementsChange,
    onTextContentChange,
    onTextAutoSize,
    onTextFormatChange,
    onTextEditorChange,
    onTextFocusChange,
    onTableCellChange,
    tableEditMaskLabel,
    creatingText,
    onTextCreate,
    creatingLine,
    onLineCreate,
    onLineCreateCancel,
    shapePathFormulas,
    snapping,
  } = props;

  const activeSelection = selection ?? EMPTY_SELECTION;
  const interactive = Boolean(onElementsChange || onSelectionChange);
  const textEditingEnabled = Boolean(onTextContentChange);
  const tableEditingEnabled = Boolean(onTableCellChange);
  const activeEditingTextId = slide.elements.find(
    (element) =>
      element.id === activeSelection.editingId &&
      activeSelection.elementIds.length === 1 &&
      element.type === 'text' &&
      !element.lock &&
      !hiddenElementIds?.includes(element.id),
  )?.id;
  const activeEditingShapeId = slide.elements.find(
    (element) =>
      element.id === activeSelection.editingId &&
      activeSelection.elementIds.length === 1 &&
      element.type === 'shape' &&
      !element.lock &&
      !hiddenElementIds?.includes(element.id),
  )?.id;
  const activeEditingTableId = slide.elements.find(
    (element) =>
      element.id === activeSelection.editingId &&
      activeSelection.elementIds.length === 1 &&
      element.type === 'table' &&
      !element.lock &&
      !hiddenElementIds?.includes(element.id),
  )?.id;
  const hasActiveEditor = Boolean(
    activeEditingTextId || activeEditingShapeId || activeEditingTableId,
  );
  const textControllerRef = useRef<TextEditorController | null>(null);
  const tableEditorRef = useRef<RendererTableEditorController | null>(null);
  const textAutoSizeRef = useRef<TextAutoSizeController | null>(null);
  const pendingTextFocusPointRef = useRef<{
    elementId: string;
    left: number;
    top: number;
  } | null>(null);
  const pendingTableFocusPointRef = useRef<{
    elementId: string;
    left: number;
    top: number;
  } | null>(null);
  const publishSelection = useCallback(
    (next: typeof activeSelection) => {
      const controller = textControllerRef.current;
      if (
        activeEditingTextId &&
        controller?.elementId === activeEditingTextId &&
        next.editingId !== activeEditingTextId
      ) {
        if (isSemanticallyEmptyText(controller.getHTML()) && onElementsChange) {
          controller.discard();
          onElementsChange?.([{ type: 'element.delete', ids: [activeEditingTextId] }]);
          if (next.elementIds.includes(activeEditingTextId)) {
            onSelectionChange?.(EMPTY_SELECTION);
            return;
          }
        } else {
          controller.flush();
        }
      }
      if (activeEditingTableId && next.editingId !== activeEditingTableId) {
        tableEditorRef.current?.flush();
        tableEditorRef.current = null;
      }
      onSelectionChange?.(next);
    },
    [activeEditingTableId, activeEditingTextId, onElementsChange, onSelectionChange],
  );

  const handleTextClick = useCallback(
    (element: PPTElement, event: ReactPointerEvent) => {
      if (
        !textEditingEnabled ||
        (element.type !== 'text' && element.type !== 'shape') ||
        element.lock ||
        (element.type === 'shape' && isSemanticallyEmptyText(element.text?.content ?? ''))
      )
        return;
      pendingTextFocusPointRef.current = {
        elementId: element.id,
        left: event.clientX,
        top: event.clientY,
      };
      publishSelection({
        elementIds: [element.id],
        primaryId: element.id,
        editingId: element.id,
      });
    },
    [publishSelection, textEditingEnabled],
  );
  const handleElementDoubleClick = useCallback(
    (element: PPTElement, event: ReactMouseEvent) => {
      if (textEditingEnabled && element.type === 'shape' && !element.lock) {
        publishSelection({
          elementIds: [element.id],
          primaryId: element.id,
          editingId: element.id,
        });
        return;
      }
      if (!tableEditingEnabled || element.type !== 'table' || element.lock) return;
      pendingTableFocusPointRef.current = {
        elementId: element.id,
        left: event.clientX,
        top: event.clientY,
      };
      publishSelection({
        elementIds: [element.id],
        primaryId: element.id,
        editingId: element.id,
      });
    },
    [publishSelection, tableEditingEnabled, textEditingEnabled],
  );

  // Overlay wrapper is `inset: 0` of the same padding-free inner box that
  // SlideCanvas fills, so its container size — and therefore the fit-computed
  // `fitScale` and centering offset — is identical to SlideCanvas's own.
  // Computing `viewportStyles`/`fitScale` here lets the interaction layer sit
  // at the same on-screen origin and zoom as the rendered elements, including
  // when `scale` is omitted and both sides auto-fit.
  const overlayRef = useRef<HTMLDivElement>(null);
  const { viewportStyles, fitScale } = useViewportSize(overlayRef, {
    viewportSize: slide.viewportSize,
    viewportRatio: slide.viewportRatio,
  });
  const canvasScale = props.scale ?? fitScale;
  const textCreationActive = Boolean(creatingText && onTextCreate);
  const lineCreationActive = Boolean(creatingLine && onLineCreate);
  const creationActive = textCreationActive || lineCreationActive;
  const { previewRect: textCreatePreview, onCanvasPointerDown: onTextCreatePointerDown } =
    useTextCreateGesture({
      active: textCreationActive,
      scale: canvasScale,
      overlayRef,
      viewportStyles,
      onCreate: onTextCreate,
    });
  const {
    preview: lineCreatePreview,
    onCanvasPointerDown: onLineCreatePointerDown,
    onCanvasContextMenu: onLineCreateContextMenu,
  } = useLineCreateGesture({
    active: lineCreationActive,
    scale: canvasScale,
    overlayRef,
    viewportStyles,
    onCreate: onLineCreate,
    onCancel: onLineCreateCancel,
  });

  const {
    workingSlide,
    guides: dragGuides,
    dragOffsets,
    onElementPointerDown,
  } = useEditGesture({
    slide,
    scale: canvasScale,
    selection: activeSelection,
    snapping,
    onSelectionChange: publishSelection,
    onElementsChange,
  });
  const onElementPointerDownRef = useRef(onElementPointerDown);
  useEffect(() => {
    onElementPointerDownRef.current = onElementPointerDown;
  }, [onElementPointerDown]);
  const handleElementPointerDown = useCallback(
    (element: PPTElement, event: ReactPointerEvent) =>
      onElementPointerDownRef.current(element, event),
    [],
  );

  // Line-handle reshape gesture. It owns its own working copy (the dragged
  // line's re-normalized props) so a selected line's endpoint/control handles
  // can be dragged to reshape it. This is independent of the box move gesture
  // above — in practice only one is ever in flight — so we layer its working
  // props on top of the box gesture's `workingSlide` below.
  const lineSnapPoints = useMemo(
    () =>
      getLineSnapPoints(
        slide.elements.filter((element) => !hiddenElementIds?.includes(element.id)),
      ),
    [hiddenElementIds, slide.elements],
  );
  const { lineDrag, onHandlePointerDown } = useLineHandleGesture({
    scale: canvasScale,
    snapPoints: lineSnapPoints,
    onElementsChange,
  });

  // Resize gesture (8-point handles on selected box elements). Like the line
  // gesture, it owns its own working copy (the resized box props), layered on
  // the box gesture's `workingSlide` below.
  const { resizeDrag, onResizeHandlePointerDown } = useResizeGesture({
    slide,
    scale: canvasScale,
    snapping,
    shapePathFormulas,
    onElementsChange,
  });

  // Rotate gesture (the handle floating above a box's top edge). It converts
  // absolute pointer positions to canvas coordinates, so it needs the overlay
  // origin (`overlayRef` + `viewportStyles`) rather than just a scale.
  const { rotateDrag, onRotateHandlePointerDown } = useRotateGesture({
    overlayRef,
    viewportStyles,
    scale: canvasScale,
    onElementsChange,
  });

  const { shapeKeypointDrag, onShapeKeypointPointerDown } = useShapeKeypointGesture({
    scale: canvasScale,
    shapePathFormulas,
    onElementsChange,
  });

  // Marquee (rubber-band) gesture. It arms from a blank-canvas pointer-down on
  // the capture surface below the element hit targets, tracks a live rectangle,
  // and on release REPLACES the selection with whatever it covers (or clears it
  // on a sub-threshold blank click). The capture surface mounts for selection
  // hosts (`onSelectionChange` — see the surface comment below); the hook itself
  // also requires `onSelectionChange` to publish.
  const { marqueeRect, onCanvasPointerDown } = useMarqueeGesture({
    slide,
    scale: canvasScale,
    overlayRef,
    viewportStyles,
    selection: activeSelection,
    excludeIds: hiddenElementIds,
    onSelectionChange: publishSelection,
  });

  // The elements to render/hit-test: the box gesture's working copy, with the
  // active handle drag's props (line reshape / resize box / rotate angle)
  // merged in so the v1 canvas, the hit layers, and the handles all preview
  // off the SAME working element and move together during a gesture. At most
  // one handle gesture is ever in flight (single-pointer hooks), so the merges
  // never compete.
  let displayElements = workingSlide.elements;
  if (lineDrag) {
    displayElements = displayElements.map((el) =>
      el.id === lineDrag.id ? ({ ...el, ...lineDrag.props } as PPTElement) : el,
    );
  }
  if (resizeDrag) {
    displayElements = displayElements.map((el) =>
      el.id === resizeDrag.id ? ({ ...el, ...resizeDrag.props } as PPTElement) : el,
    );
  }
  if (rotateDrag) {
    displayElements = displayElements.map((el) =>
      el.id === rotateDrag.id ? ({ ...el, rotate: rotateDrag.rotate } as PPTElement) : el,
    );
  }
  if (shapeKeypointDrag) {
    displayElements = displayElements.map((el) =>
      el.id === shapeKeypointDrag.id ? ({ ...el, ...shapeKeypointDrag.props } as PPTElement) : el,
    );
  }
  const displaySlide =
    displayElements === workingSlide.elements
      ? workingSlide
      : { ...workingSlide, elements: displayElements };
  const renderDragOffsets = lineDrag || resizeDrag || rotateDrag ? undefined : dragOffsets;
  const renderedSlide = renderDragOffsets ? slide : displaySlide;

  const elements = useMemo(() => {
    if (!hiddenElementIds?.length) return displayElements;
    const hidden = new Set(hiddenElementIds);
    return displayElements.filter((element) => !hidden.has(element.id));
  }, [displayElements, hiddenElementIds]);
  const activeGuides = resizeDrag?.guides ?? dragGuides;
  // Touch suppression belongs to mutation gestures: select-only hosts keep
  // native touch panning, while tap-select still receives pointer events.
  const editingTouchAction = onElementsChange ? 'none' : undefined;
  const exitElementEditing = useCallback(() => {
    if (!activeEditingTextId && !activeEditingTableId && !activeEditingShapeId) return;
    publishSelection({
      elementIds: activeSelection.elementIds,
      primaryId: activeSelection.primaryId,
      groupId: activeSelection.groupId,
    });
  }, [
    activeEditingShapeId,
    activeEditingTableId,
    activeEditingTextId,
    activeSelection,
    publishSelection,
  ]);
  const handleTextEditorChange = useCallback(
    (controller: TextEditorController | null) => {
      textControllerRef.current = controller;
      if (controller && pendingTextFocusPointRef.current?.elementId === controller.elementId) {
        pendingTextFocusPointRef.current = null;
      }
      onTextEditorChange?.(controller);
    },
    [onTextEditorChange],
  );
  const renderText = useCallback(
    (element: PPTTextElement, defaultContent: ReactNode) => {
      if (activeEditingTextId !== element.id) return defaultContent;
      const pendingFocusPoint = pendingTextFocusPointRef.current;
      const initialFocusPoint =
        pendingFocusPoint?.elementId === element.id
          ? { left: pendingFocusPoint.left, top: pendingFocusPoint.top }
          : undefined;
      return (
        <TextAutoSize
          ref={textAutoSizeRef}
          elementId={element.id}
          vertical={Boolean(element.vertical)}
          width={element.width}
          height={element.height}
          resizeActive={resizeDrag?.id === element.id}
          onAutoSize={onTextAutoSize}
        >
          <RendererTextEditor
            elementId={element.id}
            value={element.content}
            defaultColor={element.defaultColor}
            defaultFontName={element.defaultFontName}
            autoFocus
            initialFocusPoint={initialFocusPoint}
            onContentChange={onTextContentChange}
            onLayoutChange={() => textAutoSizeRef.current?.notifyContentChange()}
            onFormatChange={onTextFormatChange}
            onControllerChange={handleTextEditorChange}
            onFocusChange={onTextFocusChange}
            onEscape={exitElementEditing}
          />
        </TextAutoSize>
      );
    },
    [
      activeEditingTextId,
      handleTextEditorChange,
      onTextContentChange,
      onTextAutoSize,
      onTextFocusChange,
      onTextFormatChange,
      resizeDrag?.id,
      exitElementEditing,
    ],
  );
  const renderActiveShapeLabel = useCallback(
    (element: PPTShapeElement, defaultContent: ReactNode) => {
      if (activeEditingShapeId !== element.id)
        return renderShapeLabel?.(element, defaultContent) ?? defaultContent;
      const pendingFocusPoint = pendingTextFocusPointRef.current;
      const initialFocusPoint =
        pendingFocusPoint?.elementId === element.id
          ? { left: pendingFocusPoint.left, top: pendingFocusPoint.top }
          : undefined;
      return (
        <RendererShapeLabelEditor
          element={element}
          initialFocusPoint={initialFocusPoint}
          onContentChange={onTextContentChange}
          onFormatChange={onTextFormatChange}
          onControllerChange={handleTextEditorChange}
          onFocusChange={onTextFocusChange}
          onElementsChange={onElementsChange}
          onEscape={exitElementEditing}
        />
      );
    },
    [
      activeEditingShapeId,
      exitElementEditing,
      handleTextEditorChange,
      onElementsChange,
      onTextContentChange,
      onTextFocusChange,
      onTextFormatChange,
      renderShapeLabel,
    ],
  );
  const renderTable = useCallback(
    (element: PPTTableElement, defaultContent: ReactNode) => {
      if (activeEditingTableId !== element.id || !onTableCellChange) {
        const selectedForTableEditing =
          tableEditingEnabled &&
          activeSelection.elementIds.length === 1 &&
          activeSelection.primaryId === element.id &&
          !element.lock;
        return selectedForTableEditing ? (
          <TableEditMask label={tableEditMaskLabel ?? 'Double-click to edit'}>
            {defaultContent}
          </TableEditMask>
        ) : (
          defaultContent
        );
      }
      const pendingFocusPoint = pendingTableFocusPointRef.current;
      const initialFocusPoint =
        pendingFocusPoint?.elementId === element.id
          ? { left: pendingFocusPoint.left, top: pendingFocusPoint.top }
          : undefined;
      return (
        <RendererTableEditor
          ref={tableEditorRef}
          element={element}
          initialFocusPoint={initialFocusPoint}
          onChange={onTableCellChange}
          onTextEditorChange={handleTextEditorChange}
          onTextFormatChange={onTextFormatChange}
          onTextFocusChange={onTextFocusChange}
          onExit={exitElementEditing}
        />
      );
    },
    [
      activeEditingTableId,
      activeSelection.elementIds.length,
      activeSelection.primaryId,
      exitElementEditing,
      handleTextEditorChange,
      onTableCellChange,
      onTextFocusChange,
      onTextFormatChange,
      tableEditMaskLabel,
      tableEditingEnabled,
    ],
  );
  const handleCanvasPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (creationActive) return;
      if (!hasActiveEditor || event.button !== 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '.ProseMirror, [contenteditable="true"], [data-table-cell-id], [data-element-id], [data-hit-kind], [data-resize-handle], [data-rotate-handle], [data-line-handle]',
        )
      ) {
        return;
      }
      publishSelection(EMPTY_SELECTION);
    },
    [creationActive, hasActiveEditor, publishSelection],
  );

  return (
    // Outer wrapper carries the documented `className`/`style` pass-through
    // (which may add padding). It fills its container by default (`width`/
    // `height: 100%`, merged BEFORE `...style` so a consumer can still override)
    // — without an explicit height the inner `height: 100%` (and SlideCanvas's
    // own `height: 100%`) would resolve against an auto-height box, so
    // `useViewportSize` reads `clientHeight ≈ 0`, `fitScale ≈ 0`, and the canvas
    // renders blank when `scale` is omitted. The inner wrapper below is
    // padding-free so that SlideCanvas (normal flow) and the overlay (`inset: 0`)
    // always measure the same box — otherwise consumer padding would diverge
    // their box models and misalign the overlay from the rendered elements.
    <div
      data-editable-slide-canvas=""
      className={className}
      onPointerDownCapture={handleCanvasPointerDownCapture}
      style={{ width: '100%', height: '100%', ...style }}
    >
      <style dangerouslySetInnerHTML={{ __html: EDITOR_REACT_STYLES }} />
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {/* Pass `props.scale` (possibly undefined) THROUGH so SlideCanvas
            auto-fits with the same `fitScale` the overlay reads above. */}
        <SlideCanvas
          slide={renderedSlide}
          scale={props.scale}
          onScaleChange={onScaleChange}
          renderImage={renderImage}
          renderVideo={renderVideo}
          renderText={renderText}
          renderShapeLabel={renderActiveShapeLabel}
          renderTable={renderTable}
          videoInteractive={videoInteractive}
          elementIdPrefix={elementIdPrefix}
          dragOffsets={renderDragOffsets}
          hiddenElementIds={hiddenElementIds}
        />

        {/* Interaction overlay: hit targets below, selection chrome above.
            Every child is offset by the same `viewportStyles.left/top` that
            SlideCanvas applies to its element container, so overlay coordinates
            line up with the rendered elements even when the container is
            letterboxed (aspect ratio != slide's). */}
        <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <AlignmentGuides
            guides={activeGuides}
            viewportStyles={viewportStyles}
            canvasScale={canvasScale}
          />

          {/* Blank-canvas marquee capture surface. Rendered FIRST so it sits
              beneath the per-element hit targets in stacking order: a pointer-
              down on an element hits that element's div (painted later, on top),
              while a pointer-down on empty canvas falls to this full-bleed layer
              and arms a rubber-band select. It is a sibling of the element hit
              divs (not an ancestor), so an element pointer-down never bubbles
              into it. Gated on SELECTION (`onSelectionChange`) so select-only
              mounts still get mouse/pen marquee and sub-threshold blank-clear.
              Touch suppression is gated separately on EDITABILITY
              (`onElementsChange`): select-only mounts preserve native touch
              panning, while touch-driven marquee requires an editable mount. */}
          {Boolean(onSelectionChange) && (
            <div
              data-marquee-surface=""
              onPointerDown={onCanvasPointerDown}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: hasActiveEditor || creationActive ? 'none' : 'auto',
                touchAction: editingTouchAction,
              }}
            />
          )}
          <ElementInteractionLayer
            elements={elements}
            sourceElements={slide.elements}
            selection={activeSelection}
            interactive={interactive && !creationActive}
            movable={Boolean(onElementsChange)}
            viewportLeft={viewportStyles.left}
            viewportTop={viewportStyles.top}
            canvasScale={canvasScale}
            editingTouchAction={editingTouchAction}
            onElementPointerDown={handleElementPointerDown}
            onElementClick={textEditingEnabled ? handleTextClick : undefined}
            onElementDoubleClick={
              textEditingEnabled || tableEditingEnabled ? handleElementDoubleClick : undefined
            }
            onSelectionChange={publishSelection}
          />

          {/* Line handles: a selected, unlocked line's endpoint/control handles
              are its selection chrome (SelectionOverlay no longer draws a line
              border). Rendered above the stroke blocker so a handle pointer-
              down hits the handle, not the blocker beneath. Each handle reads
              the WORKING line (via `displayElements`), so during a reshape drag
              the handles track the previewed geometry. Handles use absolute
              SCREEN coordinates (they bake in `viewportStyles`), so they sit as
              direct children of the overlay, NOT inside the offset container.

              Gated on EDITABILITY (`onElementsChange`), not generic
              `interactive`: the reshape gesture no-ops without a mutation
              channel, so a select-only mount (only `onSelectionChange`) would
              otherwise show draggable handles that can never commit. In that
              case show NO handles — only the stroke highlight (feedback). */}
          {!creationActive &&
            Boolean(onElementsChange) &&
            elements.map((el) => {
              if (el.type !== 'line') return null;
              if (!activeSelection.elementIds.includes(el.id) || el.lock) return null;
              return (
                <LineHandles
                  key={`line-handles-${el.id}`}
                  element={el}
                  viewportStyles={viewportStyles}
                  canvasScale={canvasScale}
                  onHandlePointerDown={(handle, e) => onHandlePointerDown(el, handle, e)}
                />
              );
            })}

          {/* Box operate handles: a selected, unlocked box element gets its
              8-point resize handles and, where the kind supports it, a rotate
              handle above the top edge. Per-kind gates live in the cores:
              `getResizeHandles` (text → width axis only, by `vertical`; code →
              none) and `canRotate` (chart/video/audio excluded). Lines are
              excluded entirely — their chrome is `LineHandles` above. Handles
              read the WORKING element (`elements`), so they track the live
              preview during a resize/rotate. Like the line handles they use
              absolute SCREEN coordinates (baking in `viewportStyles`) and are
              gated on EDITABILITY (`onElementsChange`), not generic
              `interactive`: without a mutation channel the gestures no-op, so
              a select-only mount shows no draggable handles. Shown only for a
              SINGLE-element selection: these gestures transform one element,
              and per-element handles on a multi-selection would misread as
              group scaling (which is a later slice). */}
          {!creationActive &&
            Boolean(onElementsChange) &&
            activeSelection.elementIds.length === 1 &&
            elements.map((el) => {
              if (el.type === 'line') return null;
              if (!activeSelection.elementIds.includes(el.id) || el.lock) return null;
              const handles = getResizeHandles(el);
              const rotatable = canRotate(el);
              if (handles.length === 0 && !rotatable) return null;
              return (
                <Fragment key={`operate-${el.id}`}>
                  {handles.length > 0 && (
                    <ResizeHandles
                      element={el}
                      handles={handles}
                      viewportStyles={viewportStyles}
                      canvasScale={canvasScale}
                      onHandlePointerDown={(handle, e) => onResizeHandlePointerDown(el, handle, e)}
                    />
                  )}
                  {rotatable && (
                    <RotateHandle
                      element={el}
                      viewportStyles={viewportStyles}
                      canvasScale={canvasScale}
                      onPointerDown={(e) => onRotateHandlePointerDown(el, e)}
                    />
                  )}
                </Fragment>
              );
            })}

          {!creationActive &&
            Boolean(onElementsChange) &&
            activeSelection.elementIds.length === 1 &&
            elements.map((el) => {
              if (el.type !== 'shape' || !activeSelection.elementIds.includes(el.id)) return null;
              return (
                <ShapeKeypointHandles
                  key={`shape-keypoints-${el.id}`}
                  element={el as PPTShapeElement}
                  shapePathFormulas={shapePathFormulas}
                  viewportStyles={viewportStyles}
                  canvasScale={canvasScale}
                  onPointerDown={(index, event) => onShapeKeypointPointerDown(el, index, event)}
                />
              );
            })}

          {/* Live marquee rectangle, drawn while a blank-canvas rubber-band
              select is in flight. Purely visual (`pointerEvents: none`); it
              shares the element container's origin via `viewportStyles`. */}
          {!creationActive && marqueeRect && (
            <MarqueeBox
              rect={marqueeRect}
              viewportStyles={viewportStyles}
              canvasScale={canvasScale}
            />
          )}

          {textCreationActive && (
            <div
              data-text-create-surface=""
              onPointerDown={onTextCreatePointerDown}
              style={{
                position: 'absolute',
                left: `${viewportStyles.left}px`,
                top: `${viewportStyles.top}px`,
                width: `${viewportStyles.width * canvasScale}px`,
                height: `${viewportStyles.height * canvasScale}px`,
                cursor: 'crosshair',
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
            >
              {textCreatePreview && (
                <div
                  data-text-create-preview=""
                  style={{
                    position: 'absolute',
                    left: `${textCreatePreview.left * canvasScale}px`,
                    top: `${textCreatePreview.top * canvasScale}px`,
                    width: `${textCreatePreview.width * canvasScale}px`,
                    height: `${textCreatePreview.height * canvasScale}px`,
                    border: '1px solid #3b82f6',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
          )}

          {lineCreationActive && (
            <div
              data-line-create-surface=""
              onPointerDown={onLineCreatePointerDown}
              onContextMenu={onLineCreateContextMenu}
              style={{
                position: 'absolute',
                left: `${viewportStyles.left}px`,
                top: `${viewportStyles.top}px`,
                width: `${viewportStyles.width * canvasScale}px`,
                height: `${viewportStyles.height * canvasScale}px`,
                cursor: 'crosshair',
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
            >
              {lineCreatePreview && (
                <svg
                  data-line-create-preview=""
                  width="100%"
                  height="100%"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'visible',
                    pointerEvents: 'none',
                  }}
                >
                  <line
                    x1={lineCreatePreview.start[0] * canvasScale}
                    y1={lineCreatePreview.start[1] * canvasScale}
                    x2={lineCreatePreview.end[0] * canvasScale}
                    y2={lineCreatePreview.end[1] * canvasScale}
                    stroke="#333333"
                    strokeWidth="2"
                    strokeDasharray="6 4"
                  />
                </svg>
              )}
            </div>
          )}

          {/* SelectionOverlay is left untouched; wrap it in a positioning
              container matching SlideCanvas's element container so its
              per-element borders inherit the centering offset. */}
          <div
            style={{
              position: 'absolute',
              left: `${viewportStyles.left}px`,
              top: `${viewportStyles.top}px`,
              width: `${viewportStyles.width * canvasScale}px`,
              height: `${viewportStyles.height * canvasScale}px`,
              pointerEvents: 'none',
            }}
          >
            <SelectionOverlay elements={elements} selection={activeSelection} scale={canvasScale} />
          </div>
        </div>
      </div>
    </div>
  );
}
