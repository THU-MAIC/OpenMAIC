import { createElement } from 'react';
import { Video } from 'lucide-react';
import type { PPTVideoElement } from '@openmaic/dsl';
import { VideoToolbarOverlay } from '../video/VideoToolbarOverlay';
import { createDefaultVideoElement } from './defaultElements';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { deleteElement, renderAssetPicker, reorderElement } from './shared';

export function createVideoAdapter(
  context: ElementAdapterContext,
  selected: PPTVideoElement | null,
): ElementEditorAdapter<PPTVideoElement> {
  const labels = context.labels;
  const common = labels.element;
  return {
    id: 'video',
    type: 'video',
    insertType: 'video',
    insertItem: {
      id: 'insert-video',
      label: labels.insert.video,
      tooltip: labels.insert.video,
      icon: createElement(Video, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        renderAssetPicker(context, {
          accept: 'video/*',
          close,
          onPick: (asset) => {
            const id = context.host.createElementId('video');
            context.dispatch(
              [{ type: 'element.add', element: createDefaultVideoElement(id, asset) }],
              { origin: 'toolbar' },
            );
            context.select({ elementIds: [id], primaryId: id });
            close();
          },
        }),
    },
    overlay: selected ? (
      <VideoToolbarOverlay
        element={selected}
        elementIdPrefix={context.elementIdPrefix}
        labels={{
          toolbar: labels.video.toolbar,
          poster: labels.video.poster,
          bringToFront: common.bringToFront,
          sendToBack: common.sendToBack,
          delete: common.delete,
        }}
        renderPosterPicker={({ onPick, close }) =>
          renderAssetPicker(context, {
            accept: 'image/*',
            currentSrc: selected.poster,
            close,
            onPick: (asset) => onPick(asset.src),
          })
        }
        onPosterChange={(poster) =>
          context.dispatch([{ type: 'element.update', id: selected.id, props: { poster } }], {
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
