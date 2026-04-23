'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PPTImageElement } from '@/lib/types/slides';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { BaseImageElement } from '@/components/slide-renderer/components/element/ImageElement/BaseImageElement';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';

interface ImagePreviewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly images: PPTImageElement[];
  readonly selectedImageId: string | null;
  readonly onSelectedImageChange: (imageId: string) => void;
  readonly container?: HTMLElement | null;
}

function PreviewImageFrame({
  image,
  className,
}: {
  readonly image: PPTImageElement;
  readonly className?: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const previewElement = useMemo(
    () => ({
      ...image,
      top: 0,
      left: 0,
    }),
    [image],
  );
  const scale =
    frameSize.width > 0 && frameSize.height > 0 && image.width > 0 && image.height > 0
      ? Math.min(frameSize.width / image.width, frameSize.height / image.height)
      : 1;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setFrameSize({ width, height });
    });
    observer.observe(frame);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className={cn('relative flex h-full w-full items-center justify-center', className)}
    >
      <div
        className="relative shrink-0"
        style={{
          width: `${image.width * scale}px`,
          height: `${image.height * scale}px`,
        }}
      >
        <div
          className="relative origin-top-left"
          style={{
            width: `${image.width}px`,
            height: `${image.height}px`,
            transform: `scale(${scale})`,
          }}
        >
          <BaseImageElement elementInfo={previewElement} />
        </div>
      </div>
    </div>
  );
}

function DetailImagePreview({ image }: { readonly image: PPTImageElement }) {
  const stageId = useMediaStageId();
  const isPlaceholder = !!stageId && isMediaPlaceholder(image.src);
  const task = useMediaGenerationStore((s) => {
    if (!isPlaceholder) return undefined;
    const mediaTask = s.tasks[image.src];
    if (mediaTask && mediaTask.stageId !== stageId) return undefined;
    return mediaTask;
  });
  const resolvedSrc = task?.status === 'done' && task.objectUrl ? task.objectUrl : image.src;

  return (
    <img
      src={resolvedSrc}
      alt=""
      draggable={false}
      className="block h-auto w-auto max-w-[calc(96vw-4rem)] rounded-lg"
      style={{
        maxHeight: 'calc(min(92vh, 980px) - 8rem)',
      }}
      onDragStart={(e) => e.preventDefault()}
    />
  );
}

export function ImagePreviewDialog({
  open,
  onOpenChange,
  images,
  selectedImageId,
  onSelectedImageChange,
  container,
}: ImagePreviewDialogProps) {
  const { t } = useI18n();
  const selectedIndex = Math.max(
    0,
    images.findIndex((image) => image.id === selectedImageId),
  );
  const selectedImage = images[selectedIndex] ?? images[0];
  const hasMultipleImages = images.length > 1;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onOpenChange, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        container={container}
        showCloseButton={false}
        className="w-auto max-w-[min(96vw,1600px)] gap-3 border-0 bg-transparent p-0 shadow-none ring-0"
      >
        <DialogTitle className="sr-only">{t('stage.imagePreviewTitle')}</DialogTitle>

        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex max-h-[calc(min(92vh,980px)-5rem)] max-w-[calc(96vw-2rem)] items-center justify-center overflow-auto p-4">
            {selectedImage && <DetailImagePreview image={selectedImage} />}
          </div>

          {hasMultipleImages && (
            <div className="flex h-20 shrink-0 gap-2 overflow-x-auto px-4 pb-1">
              {images.map((image, index) => {
                const selected = image.id === selectedImage?.id;

                return (
                  <button
                    key={image.id}
                    type="button"
                    onClick={() => onSelectedImageChange(image.id)}
                    className={cn(
                      'relative h-[4.5rem] w-28 shrink-0 overflow-hidden rounded-md bg-white/30 p-1 shadow-sm ring-1 backdrop-blur-md transition dark:bg-gray-950/25',
                      'hover:ring-white/80 dark:hover:ring-white/40',
                      selected
                        ? 'ring-2 ring-white/90 dark:ring-white/70'
                        : 'ring-white/40 dark:ring-white/20',
                    )}
                    aria-label={`${t('stage.previewImages')} ${index + 1}, ${t(
                      'stage.imagePreviewCount',
                      { current: index + 1, total: images.length },
                    )}`}
                  >
                    <PreviewImageFrame image={image} />
                  </button>
                );
              })}
            </div>
          )}

          <div className="mx-auto flex shrink-0 flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'flex size-12 items-center justify-center rounded-full',
                'border border-white/35 bg-white/35 text-gray-700 shadow-[0_10px_28px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.08)] backdrop-blur-xl',
                'transition hover:bg-white/50 active:scale-95 dark:border-white/20 dark:bg-gray-950/30 dark:text-gray-100 dark:hover:bg-gray-950/45',
              )}
              aria-label="Close image preview, Esc"
              title="Esc"
            >
              <span className="text-3xl leading-none">×</span>
            </button>
            <span className="text-[10px] font-semibold leading-none tracking-wide text-white/80 drop-shadow dark:text-white/65">
              ESC
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
