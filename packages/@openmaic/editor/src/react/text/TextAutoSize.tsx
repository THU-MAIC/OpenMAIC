'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { TextAutoSizeIntent } from './types';

export interface TextAutoSizeController {
  notifyContentChange(): void;
}

export interface TextAutoSizeProps {
  elementId: string;
  vertical: boolean;
  width: number;
  height: number;
  resizeActive: boolean;
  onAutoSize?: (intent: TextAutoSizeIntent) => void;
  children: ReactNode;
}

const TEXT_PADDING = 20;

export const TextAutoSize = forwardRef<TextAutoSizeController, TextAutoSizeProps>(
  function TextAutoSize(
    { elementId, vertical, width, height, resizeActive, onAutoSize, children },
    ref,
  ) {
    const contentRef = useRef<HTMLDivElement>(null);
    const contentChangedRef = useRef(false);
    const pendingSizeRef = useRef<number | null>(null);
    const lastEmittedSizeRef = useRef<number | null>(null);
    const propsRef = useRef({ elementId, vertical, width, height, resizeActive, onAutoSize });
    useLayoutEffect(() => {
      propsRef.current = { elementId, vertical, width, height, resizeActive, onAutoSize };
    }, [elementId, height, onAutoSize, resizeActive, vertical, width]);
    useImperativeHandle(
      ref,
      () => ({
        notifyContentChange() {
          contentChangedRef.current = true;
        },
      }),
      [],
    );

    const emitSize = useCallback((size: number) => {
      const current = propsRef.current;
      const currentSize = current.vertical ? current.width : current.height;
      if (size === currentSize || size === lastEmittedSizeRef.current) return;
      lastEmittedSizeRef.current = size;
      current.onAutoSize?.({
        type: 'element.update',
        id: current.elementId,
        props: current.vertical ? { width: size } : { height: size },
      });
    }, []);

    useEffect(() => {
      if (!resizeActive && pendingSizeRef.current !== null) {
        const pending = pendingSizeRef.current;
        pendingSizeRef.current = null;
        emitSize(pending);
      }
    }, [emitSize, resizeActive]);

    useEffect(() => {
      const content = contentRef.current;
      if (!content || !onAutoSize || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const current = propsRef.current;
        if (!contentChangedRef.current && !current.resizeActive) return;
        const measured = current.vertical ? entry.contentRect.width : entry.contentRect.height;
        const nextSize = Math.ceil(measured + TEXT_PADDING);
        if (current.resizeActive) {
          pendingSizeRef.current = nextSize;
          return;
        }
        emitSize(nextSize);
      });
      observer.observe(content);
      return () => observer.disconnect();
    }, [emitSize, onAutoSize]);

    return (
      <div
        ref={contentRef}
        data-text-auto-size={elementId}
        style={{
          position: 'relative',
          width: vertical ? 'auto' : '100%',
          height: vertical ? '100%' : 'auto',
        }}
      >
        {children}
      </div>
    );
  },
);
