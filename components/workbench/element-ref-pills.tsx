'use client';

/**
 * Element reference pills — the staged slide elements, wherever they are shown:
 * the composer's header row, the dock's lasso tool, and a sent user bubble.
 *
 * One component for all three because they are the same list. Hovering a pill
 * writes the hover into the element-refs store, which the canvas pin layer reads
 * — so pointing at a pill rings the element it names. That link is why the pill
 * and the pin share both the violet hue and the ordinal: they are one object
 * seen in two places.
 */
import {
  AudioLines,
  AppWindow,
  BarChart3,
  Code2,
  Image as ImageIcon,
  Minus,
  Shapes,
  Sigma,
  Table2,
  Type,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useElementRefsStore } from '@/lib/store/element-refs';
import type { ElementRef } from '@/lib/workbench/element-refs';
import { ComposerPill, ComposerPillRow } from './composer-pill';

const ELEMENT_ICON: Record<string, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  shape: Shapes,
  line: Minus,
  chart: BarChart3,
  table: Table2,
  latex: Sigma,
  video: Video,
  audio: AudioLines,
  code: Code2,
};

export function ElementRefPill({
  elementRef,
  ordinal,
  onRemove,
  /** Wire pointer hover to the canvas ring. Off for a sent bubble's read-only echo. */
  linkHover = true,
}: {
  /**
   * Named `elementRef`, never `ref`: `ref` is React's own prop name and a
   * component that accepts one is asking to be handed a DOM node.
   */
  readonly elementRef: ElementRef;
  readonly ordinal: number;
  readonly onRemove?: () => void;
  readonly linkHover?: boolean;
}) {
  const { t } = useI18n();
  const Icon =
    elementRef.kind === 'interactive-element'
      ? AppWindow
      : (ELEMENT_ICON[elementRef.elementType] ?? Shapes);
  const hoverProps =
    linkHover && elementRef.kind === 'slide-element'
      ? {
          onMouseEnter: () =>
            useElementRefsStore.getState().setHovered({
              stageId: elementRef.stageId,
              sceneId: elementRef.sceneId,
              elementId: elementRef.elementId,
            }),
          onMouseLeave: () => useElementRefsStore.getState().setHovered(null),
        }
      : {};
  return (
    <ComposerPill
      tone="ref"
      testId="element-ref-pill"
      ordinal={ordinal}
      icon={<Icon size={10} />}
      label={elementRef.label}
      title={
        elementRef.kind === 'slide-element'
          ? elementRef.snapshotText || elementRef.label
          : elementRef.text || elementRef.label
      }
      onRemove={onRemove}
      removeLabel={t('edit.elementRef.remove', { label: elementRef.label })}
      {...hoverProps}
    />
  );
}

export function ElementRefPills({
  refs,
  onRemove,
  linkHover = true,
  className,
  testId = 'element-ref-pills',
  inline = false,
}: {
  readonly refs: readonly ElementRef[];
  readonly onRemove?: (ref: ElementRef) => void;
  readonly linkHover?: boolean;
  readonly className?: string;
  readonly testId?: string;
  /** Share the caller's pill row instead of opening one (see `ComposerPillRow`). */
  readonly inline?: boolean;
}) {
  if (refs.length === 0) return null;
  return (
    <ComposerPillRow className={inline ? undefined : className} contents={inline} testId={testId}>
      {refs.map((elementRef, index) => (
        <ElementRefPill
          key={
            elementRef.kind === 'slide-element'
              ? `slide:${elementRef.stageId}:${elementRef.sceneId}:${elementRef.elementId}`
              : `interactive:${elementRef.stageId}:${elementRef.sceneId}:${elementRef.selector}`
          }
          elementRef={elementRef}
          ordinal={index + 1}
          linkHover={linkHover}
          onRemove={onRemove ? () => onRemove(elementRef) : undefined}
        />
      ))}
    </ComposerPillRow>
  );
}
