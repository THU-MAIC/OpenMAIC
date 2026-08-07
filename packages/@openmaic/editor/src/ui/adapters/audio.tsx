import { createElement } from 'react';
import { Volume2 } from 'lucide-react';
import type { PPTAudioElement } from '@openmaic/dsl';
import { AudioToolbarOverlay } from '../audio/AudioToolbarOverlay';
import { createDefaultAudioElement } from './defaultElements';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { deleteElement, renderAssetPicker, reorderElement } from './shared';

export function createAudioAdapter(
  context: ElementAdapterContext,
  selected: PPTAudioElement | null,
): ElementEditorAdapter<PPTAudioElement> {
  const labels = context.labels;
  const common = labels.element;
  return {
    id: 'audio',
    type: 'audio',
    insertType: 'audio',
    insertItem: {
      id: 'insert-audio',
      label: labels.insert.audio,
      tooltip: labels.insert.audio,
      icon: createElement(Volume2, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        renderAssetPicker(context, {
          accept: 'audio/*',
          close,
          onPick: (asset) => {
            const id = context.host.createElementId('audio');
            context.dispatch(
              [{ type: 'element.add', element: createDefaultAudioElement(id, asset) }],
              { origin: 'toolbar' },
            );
            context.select({ elementIds: [id], primaryId: id });
            close();
          },
        }),
    },
    overlay: selected ? (
      <AudioToolbarOverlay
        element={selected}
        elementIdPrefix={context.elementIdPrefix}
        labels={{
          toolbar: labels.audio.toolbar,
          preview: labels.audio.preview,
          pause: labels.audio.pause,
          loop: labels.audio.loop,
          bringToFront: common.bringToFront,
          sendToBack: common.sendToBack,
          delete: common.delete,
        }}
        onLoopChange={(loop) =>
          context.dispatch([{ type: 'element.update', id: selected.id, props: { loop } }], {
            origin: 'toolbar',
          })
        }
        onBringToFront={() => reorderElement(context, selected.id, 'front')}
        onSendToBack={() => reorderElement(context, selected.id, 'back')}
        onDelete={() => deleteElement(context, selected.id)}
      />
    ) : undefined,
  };
}
