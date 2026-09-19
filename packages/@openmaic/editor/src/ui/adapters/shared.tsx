import type { ReactNode } from 'react';
import type { PPTElement } from '@openmaic/dsl';
import { DefaultAssetPicker } from '../assets/DefaultAssetPicker';
import type { EditorAssetPickerRequest } from '../host';
import type { ElementAdapterContext } from './types';

export function selectedEditableElement(context: ElementAdapterContext): PPTElement | null {
  const ids = context.selection?.elementIds ?? [];
  if (ids.length !== 1) return null;
  const id = context.selection?.primaryId ?? ids[0];
  if (context.hiddenElementIds?.includes(id)) return null;
  return context.slide.elements.find((element) => element.id === id && !element.lock) ?? null;
}

export function renderAssetPicker(
  context: ElementAdapterContext,
  request: EditorAssetPickerRequest,
): ReactNode {
  if (context.host.renderAssetPicker) return context.host.renderAssetPicker(request);
  return (
    <DefaultAssetPicker
      accept={request.accept}
      labels={context.labels.asset}
      onPick={request.onPick}
      onError={context.host.onError}
    />
  );
}

export function deleteElement(context: ElementAdapterContext, id: string): void {
  context.dispatch([{ type: 'element.delete', ids: [id] }], { origin: 'toolbar' });
  context.select({ elementIds: [] });
}

export function reorderElement(
  context: ElementAdapterContext,
  id: string,
  command: 'front' | 'back',
): void {
  context.dispatch([{ type: 'element.reorder', id, command }], { origin: 'toolbar' });
}
