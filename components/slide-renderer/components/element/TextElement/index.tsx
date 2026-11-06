'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { ProsemirrorEditor } from '../ProsemirrorEditor';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

export interface TextElementProps {
  elementInfo: PPTTextElement;
  selectElement?: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTTextElement,
    canMove?: boolean,
  ) => void;
}

function isEmptyText(content: unknown): boolean {
  return !(typeof content === 'string' ? content : '').replace(/<[^>]+>/g, '');
}

/**
 * Editable text element component
 * Includes auto-height adjustment and empty text cleanup
 */
export function TextElement({ elementInfo, selectElement }: TextElementProps) {
  const handleElementId = useCanvasStore.use.handleElementId();
  const isScaling = useCanvasStore.use.isScaling();
  const { updateElement, deleteElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const elementRef = useRef<HTMLDivElement>(null);
  const [realHeightCache, setRealHeightCache] = useState(-1);
  const [realWidthCache, setRealWidthCache] = useState(-1);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent, canMove = true) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo, canMove);
  };

  // Check if element is being handled
  const isHandleElement = handleElementId === elementInfo.id;

  // Update element height/width when scaling ends
  useEffect(() => {
    if (handleElementId !== elementInfo.id) return;

    if (!isScaling) {
      if (!elementInfo.vertical && realHeightCache !== -1) {
        updateElement({
          id: elementInfo.id,
          props: { height: realHeightCache },
        });
        // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
        setRealHeightCache(-1);
      }
      if (elementInfo.vertical && realWidthCache !== -1) {
        updateElement({
          id: elementInfo.id,
          props: { width: realWidthCache },
        });

        setRealWidthCache(-1);
      }
    }
  }, [
    isScaling,
    handleElementId,
    elementInfo.id,
    elementInfo.vertical,
    realHeightCache,
    realWidthCache,
    updateElement,
  ]);

  // Monitor text element size changes. This fires whenever the element renders,
  // with nobody editing, so it reports a measurement. A resize the user is
  // dragging is cached above and commits as an edit when the drag ends.
  const updateTextElementHeight = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const contentRect = entries[0].contentRect;
      if (!elementRef.current) return;

      const realHeight = contentRect.height + 20;
      const realWidth = contentRect.width + 20;

      if (!elementInfo.vertical && elementInfo.height !== realHeight) {
        if (!isScaling) {
          updateElement({
            id: elementInfo.id,
            props: { height: realHeight },
            measurement: true,
          });
        } else {
          setRealHeightCache(realHeight);
        }
      }
      if (elementInfo.vertical && elementInfo.width !== realWidth) {
        if (!isScaling) {
          updateElement({
            id: elementInfo.id,
            props: { width: realWidth },
            measurement: true,
          });
        } else {
          setRealWidthCache(realWidth);
        }
      }
    },
    [
      elementInfo.vertical,
      elementInfo.height,
      elementInfo.width,
      elementInfo.id,
      isScaling,
      updateElement,
    ],
  );

  // ResizeObserver setup
  useEffect(() => {
    const el = elementRef.current;
    const resizeObserver = new ResizeObserver(updateTextElementHeight);
    if (el) {
      resizeObserver.observe(el);
    }
    return () => {
      if (el) {
        resizeObserver.unobserve(el);
      }
    };
  }, [updateTextElementHeight]);

  // Remove empty text when the user leaves the element. Removing it saves the
  // whole scene, so this follows that action: rendering an empty box (entering
  // Edit, an undo, a server copy) must not write this tab's copy to the server.
  // It waits out the editor's input debounce, and decides when it fires: the box
  // must be empty as the user left it and still be empty then, and the user must
  // not have come back. A copy from elsewhere that empties it is not their doing.
  // A box with no text but a visible fill, outline or shadow is a shape in its own
  // right, and stays.
  const visibleWithoutText = Boolean(
    elementInfo.fill || elementInfo.outline?.width || elementInfo.shadow,
  );
  const latest = useRef({ content: elementInfo.content, deleteElement, visibleWithoutText });
  useEffect(() => {
    latest.current = { content: elementInfo.content, deleteElement, visibleWithoutText };
  });
  const contentAsLeft = useRef(elementInfo.content);
  const emptyTextCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleEmptyTextCheck = useCallback(() => {
    clearTimeout(emptyTextCheck.current);
    emptyTextCheck.current = setTimeout(() => {
      if (useCanvasStore.getState().handleElementId === elementInfo.id) return;
      const { content, deleteElement: remove, visibleWithoutText: visible } = latest.current;
      if (visible) return;
      if (isEmptyText(contentAsLeft.current) && isEmptyText(content)) remove(elementInfo.id);
    }, 300);
  }, [elementInfo.id]);
  useEffect(() => () => clearTimeout(emptyTextCheck.current), []);

  const wasHandled = useRef(isHandleElement);
  useEffect(() => {
    if (wasHandled.current && !isHandleElement) {
      contentAsLeft.current = latest.current.content;
      scheduleEmptyTextCheck();
    }
    wasHandled.current = isHandleElement;
  }, [isHandleElement, scheduleEmptyTextCheck]);

  // Update content
  const updateContent = useCallback(
    (content: string, ignore = false) => {
      updateElement({
        id: elementInfo.id,
        props: { content },
      });
      latest.current = { ...latest.current, content };

      if (!ignore) addHistorySnapshot();
      // The user's own input, reported after they left: text cleared just before
      // the leave arrives just after it.
      if (useCanvasStore.getState().handleElementId !== elementInfo.id) {
        contentAsLeft.current = content;
        scheduleEmptyTextCheck();
      }
    },
    [elementInfo.id, updateElement, addHistorySnapshot, scheduleEmptyTextCheck],
  );

  return (
    <div
      className={`editable-element-text absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{
          transform: `rotate(${elementInfo.rotate}deg)`,
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
        }}
      >
        <div
          ref={elementRef}
          className={`element-content relative p-[10px] leading-[1.5] break-words ${elementInfo.lock ? 'cursor-default' : 'cursor-move'}`}
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
          onMouseDown={(e) => handleSelectElement(e)}
          onTouchStart={(e) => handleSelectElement(e)}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />

          <div className="text relative">
            <ProsemirrorEditor
              elementId={elementInfo.id}
              defaultColor={elementInfo.defaultColor}
              defaultFontName={elementInfo.defaultFontName}
              editable={!elementInfo.lock}
              value={typeof elementInfo.content === 'string' ? elementInfo.content : ''}
              onUpdate={({ value, ignore }) => updateContent(value, ignore)}
              onMouseDown={(e) => handleSelectElement(e as React.MouseEvent, false)}
            />
          </div>

          {/* Drag handlers for better interaction when text overflows */}
          <div className="drag-handler top absolute left-0 right-0 h-[10px] top-0" />
          <div className="drag-handler bottom absolute left-0 right-0 h-[10px] bottom-0" />
        </div>
      </div>
    </div>
  );
}
