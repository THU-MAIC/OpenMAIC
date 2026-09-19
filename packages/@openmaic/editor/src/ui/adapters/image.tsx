import type { PPTImageElement } from '@openmaic/dsl';
import { ImageToolbarOverlay } from '../element/ImageToolbarOverlay';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { deleteElement, renderAssetPicker, reorderElement } from './shared';

export function createImageAdapter(
  context: ElementAdapterContext,
  element: PPTImageElement,
): ElementEditorAdapter<PPTImageElement> {
  const common = context.labels.element;
  return {
    id: 'image',
    type: 'image',
    overlay: (
      <ImageToolbarOverlay
        element={element}
        elementIdPrefix={context.elementIdPrefix}
        labels={{ ...common, ...context.labels.image }}
        renderPicker={({ onPick, close }) =>
          renderAssetPicker(context, {
            accept: 'image/*',
            currentSrc: element.src,
            close,
            onPick: (asset) => onPick(asset.src),
          })
        }
        onReplace={(src) =>
          context.dispatch(
            [{ type: 'element.update', id: element.id, props: { src, clip: undefined } }],
            { origin: 'toolbar' },
          )
        }
        onFlip={(axis) =>
          context.dispatch(
            [
              {
                type: 'element.update',
                id: element.id,
                props: axis === 'H' ? { flipH: !element.flipH } : { flipV: !element.flipV },
              },
            ],
            { origin: 'toolbar' },
          )
        }
        onBringToFront={() => reorderElement(context, element.id, 'front')}
        onSendToBack={() => reorderElement(context, element.id, 'back')}
        onDelete={() => deleteElement(context, element.id)}
      />
    ),
  };
}
