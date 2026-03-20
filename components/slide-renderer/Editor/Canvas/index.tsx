'use client';

import { useRef, useState, useEffect } from 'react';
import { nanoid } from 'nanoid';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useViewportSize } from './hooks/useViewportSize';
import { useSelectElement } from './hooks/useSelectElement';
import { useDragElement } from './hooks/useDragElement';
import { useRotateElement } from './hooks/useRotateElement';
import { useMouseSelection } from './hooks/useMouseSelection';
import { useScaleElement } from './hooks/useScaleElement';
import { useDragLineElement } from './hooks/useDragLineElement';
import { useMoveShapeKeypoint } from './hooks/useMoveShapeKeypoint';
import { useInsertFromCreateSelection } from './hooks/useInsertFromCreateSelection';
import { useDrop } from './hooks/useDrop';
import { AlignmentLine } from './AlignmentLine';
import { MouseSelection } from './MouseSelection';
import { ViewportBackground } from './ViewportBackground';
import { EditableElement } from './EditableElement';
import { Operate } from './Operate';
import { MultiSelectOperate } from './Operate/MultiSelectOperate';
import { ElementCreateSelection } from './ElementCreateSelection';
import { ShapeCreateCanvas } from './ShapeCreateCanvas';
import { Ruler } from './Ruler';
import { GridLines } from './GridLines';
import { LinkDialog } from './LinkDialog';
import type { PPTElement, PPTTextElement, PPTShapeElement, SlideTheme } from '@/lib/types/slides';
import type { AlignmentLineProps, CreateCustomShapeData } from '@/lib/types/edit';
import type { ContextmenuItem } from './EditableElement';
import type { SlideContent } from '@/lib/types/stage';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuShortcut,
  ContextMenuItem,
} from '@/components/ui/context-menu';

export interface CanvasProps {
  editable?: boolean;
}

/**
 * Canvas component
 *
 * Architecture:
 * - Slide data (elements, background) → Scene Context (from stageStore)
 * - Local element list → useRef + useState (for drag/scale/rotate operations)
 * - Canvas UI state (selection, toolbar) → Canvas Store
 * - Keyboard state → Keyboard Store
 *
 * Usage:
 * <SceneProvider>
 *   <Canvas />
 * </SceneProvider>
 */
export function Canvas(_props: CanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Subscribe to specific parts for performance optimization
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  // Canvas UI state
  const canvasScale = useCanvasStore.use.canvasScale();
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const handleElementId = useCanvasStore.use.handleElementId();
  const hiddenElementIdList = useCanvasStore.use.hiddenElementIdList();
  const creatingElement = useCanvasStore.use.creatingElement();
  const creatingCustomShape = useCanvasStore.use.creatingCustomShape();
  const showRuler = useCanvasStore.use.showRuler();
  const gridLineSize = useCanvasStore.use.gridLineSize();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setGridLineSize = useCanvasStore.use.setGridLineSize();
  const setRulerState = useCanvasStore.use.setRulerState();

  // Keyboard state
  const spaceKeyState = useKeyboardStore((state) => state.spaceKeyState);

  const [alignmentLines, setAlignmentLines] = useState<AlignmentLineProps[]>([]);
  const [linkDialogVisible, setLinkDialogVisible] = useState(false);

  // Local element list for drag/scale/rotate operations
  const elementListRef = useRef<PPTElement[]>(elements || []);
  const [elementList, setElementList] = useState<PPTElement[]>(elements || []);

  // Sync store elements to local state
  useEffect(() => {
    const newElements = elements ? JSON.parse(JSON.stringify(elements)) : [];
    elementListRef.current = newElements;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync store elements to local state
    setElementList(newElements);
  }, [elements]);

  // Viewport size and positioning
  const { viewportStyles, dragViewport } = useViewportSize(canvasRef);

  // Initialize drop handler
  useDrop(canvasRef);

  // Element drag (with alignment snapping)
  const { dragElement } = useDragElement(elementListRef, setElementList, setAlignmentLines);

  // Element selection
  const { selectElement } = useSelectElement(elementListRef, dragElement);

  // Mouse selection
  const { mouseSelection, mouseSelectionVisible, mouseSelectionQuadrant, updateMouseSelection } =
    useMouseSelection(elementListRef, viewportRef);

  // Element operations
  const { scaleElement, scaleMultiElement } = useScaleElement(
    elementListRef,
    setElementList,
    setAlignmentLines,
  );
  const { rotateElement } = useRotateElement(
    elementListRef,
    setElementList,
    viewportRef,
    canvasScale,
  );
  const { dragLineElement } = useDragLineElement(elementListRef, setElementList);
  const { moveShapeKeypoint } = useMoveShapeKeypoint(elementListRef, setElementList, canvasScale);

  // Create element from selection
  const { insertElementFromCreateSelection } = useInsertFromCreateSelection(viewportRef);

  // Click on blank canvas area: clear active elements
  const handleClickBlankArea = (e: React.MouseEvent) => {
    // Check if the click target is a context menu element (menu content in Portal)
    const target = e.target as HTMLElement;
    if (
      target.closest('[data-slot="context-menu-content"]') ||
      target.closest('[data-slot="context-menu-sub-content"]') ||
      target.closest('[data-slot="context-menu-item"]') ||
      target.closest('[data-slot="context-menu-sub-trigger"]')
    ) {
      return; // Skip blank area handling if clicking on context menu
    }

    if (activeElementIdList.length) {
      setActiveElementIdList([]);
    }

    if (!spaceKeyState) {
      updateMouseSelection(e);
    } else {
      dragViewport(e);
    }
  };

  // Double-click blank area to insert text
  const handleDblClick = (e: React.MouseEvent) => {
    if (activeElementIdList.length || creatingElement || creatingCustomShape) return;
    if (!viewportRef.current) return;

    const viewportRect = viewportRef.current.getBoundingClientRect();
    const left = (e.pageX - viewportRect.x) / canvasScale;
    const top = (e.pageY - viewportRect.y) / canvasScale;

    const newElement: PPTTextElement = {
      type: 'text',
      id: nanoid(10),
      left: left - 150,
      top: top - 25,
      width: 300,
      height: 50,
      rotate: 0,
      content: '<p><br/></p>',
      defaultFontName: theme?.fontName ?? 'Microsoft YaHei',
      defaultColor: theme?.fontColor ?? '#333333',
    };
    addElement(newElement);
    addHistorySnapshot();
  };

  const openLinkDialog = () => {
    setLinkDialogVisible(true);
  };

  const { pasteElement, selectAllElements, deleteAllElements, addElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();
  const theme = useSceneSelector<SlideContent, SlideTheme>((content) => content.canvas.theme);

  const contextmenus = (): ContextmenuItem[] => {
    return [
      {
        text: '粘贴',
        subText: 'Ctrl + V',
        handler: pasteElement,
      },
      {
        text: '全选',
        subText: 'Ctrl + A',
        handler: selectAllElements,
      },
      {
        text: '标尺',
        subText: showRuler ? '√' : '',
        handler: () => setRulerState(!showRuler),
      },
      {
        text: '网格线',
        handler: () => setGridLineSize(gridLineSize ? 0 : 50),
        children: [
          {
            text: '无',
            subText: gridLineSize === 0 ? '√' : '',
            handler: () => setGridLineSize(0),
          },
          {
            text: '小',
            subText: gridLineSize === 25 ? '√' : '',
            handler: () => setGridLineSize(25),
          },
          {
            text: '中',
            subText: gridLineSize === 50 ? '√' : '',
            handler: () => setGridLineSize(50),
          },
          {
            text: '大',
            subText: gridLineSize === 100 ? '√' : '',
            handler: () => setGridLineSize(100),
          },
        ],
      },
      {
        text: '重置当前页',
        handler: deleteAllElements,
      },
    ];
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="canvas relative h-full w-full overflow-hidden bg-gray-100 select-none"
          ref={canvasRef}
          onMouseDown={handleClickBlankArea}
          onDoubleClick={handleDblClick}
        >
          {/* Element creation selection */}
          {creatingElement && (
            <ElementCreateSelection onCreated={insertElementFromCreateSelection} />
          )}

          {/* Custom shape creation canvas */}
          {creatingCustomShape && (
            <ShapeCreateCanvas
              onCreated={(data: CreateCustomShapeData) => {
                const w = Math.abs(data.end[0] - data.start[0]);
                const h = Math.abs(data.end[1] - data.start[1]);
                const newElement: PPTShapeElement = {
                  type: 'shape',
                  id: nanoid(10),
                  left: data.start[0],
                  top: data.start[1],
                  width: Math.max(w, 20),
                  height: Math.max(h, 20),
                  rotate: 0,
                  viewBox: data.viewBox,
                  path: data.path,
                  fixedRatio: false,
                  fill: data.fill ?? theme?.themeColors?.[0] ?? '#4B9CDC',
                  outline: data.outline,
                  special: true,
                };
                addElement(newElement);
                addHistorySnapshot();
              }}
            />
          )}

          {/* Viewport wrapper */}
          <div
            className="viewport-wrapper absolute shadow-[0_0_0_1px_rgba(0,0,0,0.01),0_0_12px_0_rgba(0,0,0,0.1)]"
            style={{
              width: `${viewportStyles.width * canvasScale}px`,
              height: `${viewportStyles.height * canvasScale}px`,
              left: `${viewportStyles.left}px`,
              top: `${viewportStyles.top}px`,
            }}
          >
            {/* Operations layer - alignment lines and selection handles */}
            <div className="operates absolute top-0 left-0 w-full h-full pointer-events-none">
              {/* Alignment lines */}
              {alignmentLines.map((line, index) => (
                <AlignmentLine
                  key={`${line.type}-${line.axis.x}-${line.axis.y}-${index}`}
                  type={line.type}
                  axis={line.axis}
                  length={line.length}
                  canvasScale={canvasScale}
                />
              ))}

              {/* Multi-select operations */}
              {activeElementIdList.length > 1 && (
                <MultiSelectOperate
                  elementList={elementList}
                  scaleMultiElement={scaleMultiElement}
                />
              )}

              {/* Single element operations */}
              {elementList.map(
                (element: PPTElement) =>
                  !hiddenElementIdList.includes(element.id) && (
                    <Operate
                      key={element.id}
                      elementInfo={element}
                      isSelected={activeElementIdList.includes(element.id)}
                      isActive={handleElementId === element.id}
                      isActiveGroupElement={activeGroupElementId === element.id}
                      isMultiSelect={activeElementIdList.length > 1}
                      rotateElement={rotateElement}
                      scaleElement={scaleElement}
                      dragLineElement={dragLineElement}
                      moveShapeKeypoint={moveShapeKeypoint}
                      openLinkDialog={openLinkDialog}
                    />
                  ),
              )}

              <ViewportBackground />
            </div>

            {/* Viewport - the actual slide canvas */}
            <div
              ref={viewportRef}
              className="viewport absolute top-0 left-0 origin-top-left"
              style={{
                width: `${viewportStyles.width}px`,
                height: `${viewportStyles.height}px`,
                transform: `scale(${canvasScale})`,
              }}
            >
              {/* Grid lines */}
              {gridLineSize > 0 && <GridLines />}

              {/* Mouse selection rectangle */}
              {mouseSelectionVisible && (
                <MouseSelection
                  top={mouseSelection.top}
                  left={mouseSelection.left}
                  width={mouseSelection.width}
                  height={mouseSelection.height}
                  quadrant={mouseSelectionQuadrant}
                  canvasScale={canvasScale}
                />
              )}

              {/* Render all elements */}
              {elementList.map((element: PPTElement, index: number) =>
                !hiddenElementIdList.includes(element.id) ? (
                  <EditableElement
                    key={element.id}
                    elementInfo={element}
                    elementIndex={index + 1}
                    isMultiSelect={activeElementIdList.length > 1}
                    selectElement={selectElement}
                    openLinkDialog={openLinkDialog}
                  />
                ) : null,
              )}
            </div>
          </div>

          {/* Ruler */}
          {showRuler && <Ruler viewportStyles={viewportStyles} elementList={elementList} />}

          {/* Drag mask when space key is pressed */}
          {spaceKeyState && <div className="drag-mask absolute inset-0 cursor-grab" />}

          <LinkDialog visible={linkDialogVisible} onClose={() => setLinkDialogVisible(false)} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {contextmenus().map((item, index) => {
          if (item.divider) {
            return <ContextMenuSeparator key={index} />;
          }

          // If has children, use submenu component
          if (item.children && item.children.length > 0) {
            return (
              <ContextMenuSub key={index}>
                <ContextMenuSubTrigger disabled={item.disable} hidden={item.hide}>
                  {item.text}
                  {item.subText && <ContextMenuShortcut>{item.subText}</ContextMenuShortcut>}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {item.children.map((child, childIndex) =>
                    child.divider ? (
                      <ContextMenuSeparator key={childIndex} />
                    ) : (
                      <ContextMenuItem
                        key={childIndex}
                        onClick={(e) => {
                          e.stopPropagation();
                          child.handler?.();
                        }}
                        disabled={child.disable}
                        hidden={child.hide}
                      >
                        {child.text}
                        {child.subText && (
                          <ContextMenuShortcut>{child.subText}</ContextMenuShortcut>
                        )}
                      </ContextMenuItem>
                    ),
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>
            );
          }

          // Regular menu item
          return (
            <ContextMenuItem
              key={index}
              onClick={(e) => {
                e.stopPropagation();
                item.handler?.();
              }}
              disabled={item.disable}
              hidden={item.hide}
            >
              {item.text}
              {item.subText && <ContextMenuShortcut>{item.subText}</ContextMenuShortcut>}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default Canvas;
