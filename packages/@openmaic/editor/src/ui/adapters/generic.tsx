import type { PPTElement } from '@openmaic/dsl';
import { ElementToolbarOverlay } from '../element/ElementToolbarOverlay';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { deleteElement, reorderElement } from './shared';

export function createGenericAdapter(
  context: ElementAdapterContext,
  element: PPTElement,
): ElementEditorAdapter {
  return {
    id: 'generic',
    type: element.type,
    overlay: (
      <ElementToolbarOverlay
        element={element}
        elementIdPrefix={context.elementIdPrefix}
        labels={context.labels.element}
        onBringToFront={() => reorderElement(context, element.id, 'front')}
        onSendToBack={() => reorderElement(context, element.id, 'back')}
        onDelete={() => deleteElement(context, element.id)}
      />
    ),
  };
}
