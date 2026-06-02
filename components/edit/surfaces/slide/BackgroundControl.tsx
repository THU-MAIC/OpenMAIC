'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ColorPicker } from './ColorPicker';
import { ImagePicker } from './ImagePicker';
import { updateSlideBackground, useResolvedSlideContent } from './use-slide-surface';

/**
 * Slide-background picker — solid color / image tabs. Slide-level, so it
 * dispatches `slide.update {background}` rather than an element op. Seeded from
 * the current background; defaults to the Solid tab (white) when none is set.
 */
export function BackgroundControl() {
  const { t } = useI18n();
  const bg = useResolvedSlideContent().canvas.background;
  const color = bg?.type === 'solid' && bg.color ? bg.color : '#ffffff';
  return (
    <Tabs defaultValue={bg?.type === 'image' ? 'image' : 'solid'} className="w-full">
      <TabsList className="w-full">
        <TabsTrigger value="solid" className="flex-1">
          {t('edit.background.solid')}
        </TabsTrigger>
        <TabsTrigger value="image" className="flex-1">
          {t('edit.background.image')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="solid" className="pt-3">
        <ColorPicker
          className="w-full"
          value={color}
          onChange={(c) => updateSlideBackground({ type: 'solid', color: c })}
          onCommit={(c) => updateSlideBackground({ type: 'solid', color: c })}
        />
      </TabsContent>
      <TabsContent value="image" className="pt-3">
        <ImagePicker
          onPick={(src) => updateSlideBackground({ type: 'image', image: { src, size: 'cover' } })}
        />
      </TabsContent>
    </Tabs>
  );
}
