'use client';

import { FlipHorizontal, FlipVertical, ImageUp } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { PPTImageElement } from '@openmaic/dsl';
import { ImagePicker } from './ImagePicker';
import { replaceImageSrc, toggleImageFlip } from './use-slide-surface';

const BTN =
  'flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';

/**
 * Replace / flip controls for a selected image element. Mounted inside the
 * AnchoredElementBar (itself a portaled popover), so `onMouseDown` preventDefault
 * on each button keeps the canvas selection alive across the click.
 */
export function ImageActions({ element }: { readonly element: PPTImageElement }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('edit.image.replace')}
            title={t('edit.image.replace')}
            onMouseDown={(e) => e.preventDefault()}
            className={BTN}
          >
            <ImageUp className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="w-72"
        >
          <ImagePicker onPick={(src) => replaceImageSrc(element.id, src)} />
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={t('edit.image.flipH')}
        title={t('edit.image.flipH')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleImageFlip(element, 'H')}
        className={BTN}
      >
        <FlipHorizontal className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={t('edit.image.flipV')}
        title={t('edit.image.flipV')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleImageFlip(element, 'V')}
        className={BTN}
      >
        <FlipVertical className="h-4 w-4" />
      </button>
    </div>
  );
}
