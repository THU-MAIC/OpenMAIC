'use client';

import { useState, type ReactNode } from 'react';
import { FlipHorizontal, FlipVertical, ImageUp } from 'lucide-react';
import type { PPTImageElement } from '@openmaic/dsl';
import { ElementToolbarOverlay } from './ElementToolbarOverlay';
import type { ImageEditorLabels, ImagePickerProps } from '../types';

export interface ImageToolbarOverlayProps {
  readonly element: PPTImageElement;
  readonly elementIdPrefix?: string;
  readonly labels: ImageEditorLabels;
  readonly renderPicker?: (props: ImagePickerProps) => ReactNode;
  readonly onReplace?: (src: string) => void;
  readonly onFlip?: (axis: 'H' | 'V') => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export function ImageToolbarOverlay({
  element,
  elementIdPrefix,
  labels,
  renderPicker,
  onReplace,
  onFlip,
  onBringToFront,
  onSendToBack,
  onDelete,
}: ImageToolbarOverlayProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <ElementToolbarOverlay
      element={element}
      elementIdPrefix={elementIdPrefix}
      labels={labels}
      onBringToFront={onBringToFront}
      onSendToBack={onSendToBack}
      onDelete={onDelete}
      leading={
        <>
          {renderPicker && onReplace ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
              aria-label={labels.replace}
              aria-pressed={pickerOpen}
              data-tooltip={labels.replace}
              data-tooltip-placement="bottom"
              title={labels.replace}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <ImageUp aria-hidden="true" />
            </button>
          ) : null}
          {onFlip ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
              aria-label={labels.flipH}
              data-tooltip={labels.flipH}
              data-tooltip-placement="bottom"
              title={labels.flipH}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFlip('H')}
            >
              <FlipHorizontal aria-hidden="true" />
            </button>
          ) : null}
          {onFlip ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
              aria-label={labels.flipV}
              data-tooltip={labels.flipV}
              data-tooltip-placement="bottom"
              title={labels.flipV}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFlip('V')}
            >
              <FlipVertical aria-hidden="true" />
            </button>
          ) : null}
          {pickerOpen && renderPicker && onReplace ? (
            <div
              className="maic-editing-ui-image-picker-popover"
              role="dialog"
              aria-label={labels.replace}
            >
              {renderPicker({
                element,
                onPick: (src) => {
                  onReplace(src);
                  setPickerOpen(false);
                },
                close: () => setPickerOpen(false),
              })}
            </div>
          ) : null}
        </>
      }
    />
  );
}
